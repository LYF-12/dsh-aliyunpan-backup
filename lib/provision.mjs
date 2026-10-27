import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Transform } from 'node:stream';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { ensureHome, homeDir, readConfig, resolveExe, toolName, writeConfig } from './config.mjs';

/** 官方发布仓库：tickstep/aliyunpan（aliyunpan-go 的命令行客户端）。 */
const REPO = 'tickstep/aliyunpan';
export const RELEASES_LATEST = 'https://api.github.com/repos/' + REPO + '/releases/latest';
export const RELEASES_TAG = (tag) => 'https://api.github.com/repos/' + REPO + '/releases/tags/' + encodeURIComponent(tag);

/** 上限：正常包约 7–10 MB，超过 120 MB 视为异常。 */
const MAX_BYTES = 120 * 1024 * 1024;
/** 单次下载：连接/无数据 45 秒算卡死，整体 10 分钟封顶。 */
const IDLE_MS = 45 * 1000;
const HARD_MS = 10 * 60 * 1000;

/** GitHub 直连不稳时依次尝试的镜像前缀（只对 github 系地址生效）。 */
export const MIRRORS = [
  { name: 'ghfast.top', prefix: 'https://ghfast.top/' },
  { name: 'gh-proxy.com', prefix: 'https://gh-proxy.com/' },
];

/** fetch 报的永远只有 "fetch failed"，真正的原因躲在 cause 链里，这里展开成可读文本。 */
export function describeError(error) {
  const parts = [];
  let current = error;
  let guard = 0;
  while (current && guard < 6) {
    const code = current.code ? String(current.code) : '';
    const message = String(current.message || current);
    const piece = code && message.indexOf(code) === -1 ? code + ' ' + message : message;
    if (piece && parts.indexOf(piece) === -1) parts.push(piece);
    current = current.cause;
    guard += 1;
  }
  return parts.join(' | ') || 'unknown error';
}

function isGithubHost(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return (
    host === 'github.com' ||
    host === 'objects.githubusercontent.com' ||
    host === 'api.github.com' ||
    host.endsWith('.github.com') ||
    host.endsWith('.githubusercontent.com')
  );
}

/** 生成这个地址的镜像替身列表（非 github 地址返回空数组）。 */
export function mirrorUrls(url, mirrors = MIRRORS) {
  if (!isGithubHost(url)) return [];
  return (Array.isArray(mirrors) ? mirrors : MIRRORS)
    .filter((item) => item && item.prefix)
    .map((item) => ({ name: String(item.name || item.prefix), url: item.prefix + url }));
}

/** 依次尝试：官方直连 → 镜像们。 */
export function downloadSources(url, mirrors) {
  const list = [{ name: 'direct', url }];
  for (const item of mirrorUrls(url, mirrors)) list.push(item);
  return list;
}
const OS_TOKENS = { win32: ['windows'], darwin: ['darwin', 'macos', 'osx'], linux: ['linux'], freebsd: ['freebsd'] };
const ARCH_TOKENS = { x64: ['x64', 'amd64'], arm64: ['arm64', 'aarch64'], ia32: ['x86', '386'], arm: ['armv7', 'armhf'] };

/**
 * 从 release 的资产列表里挑出当前平台该下的那个包。
 * 纯函数，方便测试：assets = [{name, url|browser_download_url, size}]
 */
export function pickAsset(assets, platform = process.platform, arch = process.arch) {
  const list = Array.isArray(assets) ? assets : [];
  const osTokens = OS_TOKENS[platform] || [platform];
  const archTokens = ARCH_TOKENS[arch] || [arch];
  // 明确属于别的架构的包要排除，否则 x64 上可能抓到 arm64 的包。
  const otherArch = Object.entries(ARCH_TOKENS)
    .filter(([key]) => key !== arch)
    .flatMap(([, tokens]) => tokens)
    .filter((token) => token.length > 2);
  let best = null;
  for (const asset of list) {
    const name = String((asset && asset.name) || '');
    const lower = name.toLowerCase();
    if (!lower || !/\.(zip|tar\.gz|tgz)$/.test(lower)) continue;
    if (!osTokens.some((token) => lower.includes(token))) continue;
    const archHit = archTokens.some((token) => lower.includes(token));
    if (!archHit && otherArch.some((token) => lower.includes(token))) continue;
    const preferredExt = platform === 'win32' ? /\.zip$/ : /\.(tar\.gz|tgz)$/;
    const score = (archHit ? 4 : 0) + (preferredExt.test(lower) ? 2 : 1);
    if (!best || score > best.score) {
      best = { name, url: asset.browser_download_url || asset.url || '', size: Number(asset.size) || null, score };
    }
  }
  if (!best || !best.url) return null;
  return { name: best.name, url: best.url, size: best.size };
}

export function supportedPlatform(platform = process.platform, arch = process.arch) {
  return { platform, arch, osOk: Boolean(OS_TOKENS[platform]), archOk: Boolean(ARCH_TOKENS[arch]) };
}

/** 本机运行环境：aliyunpan 是否就绪、插件托管副本在哪。 */
export function exeStatus() {
  const target = path.join(homeDir(), 'tools', toolName());
  let exe = null;
  try {
    exe = resolveExe();
  } catch {
    exe = null;
  }
  const support = supportedPlatform();
  return {
    platform: process.platform,
    arch: process.arch,
    supported: support.osOk && support.archOk,
    target,
    exe: exe || '',
    installed: Boolean(exe),
    managed: Boolean(exe) && path.resolve(exe) === path.resolve(target),
  };
}

const job = { running: false, phase: 'idle', startedAt: 0, finishedAt: 0, log: [], result: null, error: null };

function log(line) {
  const ts = new Date().toISOString().slice(11, 19);
  job.log.push('[' + ts + '] ' + line);
  if (job.log.length > 500) job.log.splice(0, job.log.length - 500);
}

function customUrl() {
  try {
    return readConfig().aliyunpanUrl || '';
  } catch {
    return '';
  }
}

export function provisionState() {
  const info = exeStatus();
  return {
    ...info,
    running: job.running,
    phase: job.phase,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    log: job.log.slice(-160),
    result: job.result,
    error: job.error,
    customUrl: customUrl(),
  };
}

async function releaseInfo(tag) {
  const url = tag ? RELEASES_TAG(tag) : RELEASES_LATEST;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 25000);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'user-agent': 'dsh-aliyunpan-backup', accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error('GitHub API HTTP ' + res.status + '（' + (res.status === 403 ? '可能被限流，稍后再试' : '网络或代理问题') + '）');
    const json = await res.json();
    const assets = (Array.isArray(json.assets) ? json.assets : []).map((asset) => ({
      name: asset.name,
      browser_download_url: asset.browser_download_url,
      size: asset.size,
    }));
    return { tag: String(json.tag_name || tag || ''), assets };
  } finally {
    clearTimeout(timer);
  }
}

function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响主流程 */
  }
}

function dropFile(target) {
  try {
    fs.rmSync(target, { force: true });
  } catch {
    /* 清理失败不影响主流程 */
  }
}

/** 单次下载：有进度就重置看门狗，45 秒没数据算卡死，整体 10 分钟封顶。 */
async function downloadOnce(url, dest, expectedSize) {
  dropFile(dest);
  const ctl = new AbortController();
  let idle = null;
  const touch = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => ctl.abort(new Error('超过 ' + Math.round(IDLE_MS / 1000) + ' 秒没有收到数据')), IDLE_MS);
  };
  const hard = setTimeout(() => ctl.abort(new Error('下载超时（' + Math.round(HARD_MS / 60000) + ' 分钟）')), HARD_MS);
  touch();
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctl.signal,
      headers: { 'user-agent': 'dsh-aliyunpan-backup', accept: '*/*' },
    });
    if (!res.ok) {
      const error = new Error('HTTP ' + res.status + (res.status === 404 ? '（发布的文件不存在，检查地址）' : ''));
      // 4xx 重试没有意义，直接换下一个源。
      error.retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      throw error;
    }
    touch();
    const total = Number(res.headers.get('content-length')) || expectedSize || 0;
    if (total > MAX_BYTES) throw new Error('文件异常大（' + total + ' 字节），已中止');
    const hash = crypto.createHash('sha256');
    let got = 0;
    let mark = 10;
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        got += chunk.length;
        if (got > MAX_BYTES) return cb(new Error('文件超过上限，已中止'));
        hash.update(chunk);
        touch();
        if (total) {
          const pct = Math.min(100, Math.floor((got / total) * 100));
          if (pct >= mark) {
            log('下载 ' + pct + '%（' + (got / 1048576).toFixed(1) + ' MB）');
            mark = pct + 10;
          }
        }
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(dest));
    if (!got) throw new Error('一个字节都没下到（可能是被劫持的空响应）');
    return { bytes: got, sha256: hash.digest('hex') };
  } catch (error) {
    dropFile(dest);
    throw error;
  } finally {
    clearTimeout(hard);
    if (idle) clearTimeout(idle);
  }
}

/** 官方直连 → 镜像，逐个试，每个最多 2 次；全挂才抛错并带上每一条真实原因。 */
async function fetchArchive(asset, tmp) {
  const sources = downloadSources(asset.url, asset.mirrors);
  const archive = path.join(tmp, path.basename(asset.name) || 'aliyunpan-archive');
  const failures = [];
  for (const source of sources) {
    const label = source.name === 'direct' ? '官方直连' : '镜像 ' + source.name;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (attempt > 1) log('重试 ' + label + '（第 ' + attempt + ' 次）');
      try {
        const meta = await downloadOnce(source.url, archive, asset.size);
        log('下载完成：' + (meta.bytes / 1048576).toFixed(2) + ' MB，sha256 ' + meta.sha256.slice(0, 16) + '…（' + label + '）');
        return { archive, meta, source: source.name };
      } catch (error) {
        const detail = describeError(error);
        failures.push(label + '：' + detail);
        log('下载失败（' + label + '）：' + detail);
        if (error && error.retryable === false) break;
      }
    }
  }
  throw new Error('所有下载源都失败 → ' + failures.join(' ; '));
}

/** 本地来源：目录 / 压缩包 / 直接指到 aliyunpan.exe。 */
function localSourcePath(spec) {
  const text = String(spec || '').trim();
  if (!text) return '';
  if (/^file:\/\//i.test(text)) {
    try {
      return fileURLToPath(text);
    } catch {
      throw new Error('file:// 地址解析失败：' + text);
    }
  }
  return text;
}

function installLocal(spec, tmp) {
  const source = localSourcePath(spec);
  if (!source) throw new Error('没有给本地文件路径');
  let stat;
  try {
    stat = fs.statSync(source);
  } catch {
    throw new Error('本地路径不存在：' + source);
  }
  log('使用本地文件：' + source);
  if (stat.isDirectory()) {
    const binary = findBinary(source, toolName());
    if (!binary) throw new Error('目录里没找到 ' + toolName() + '：' + source);
    return binary;
  }
  if (!stat.isFile()) throw new Error('既不是文件也不是目录：' + source);
  const lower = source.toLowerCase();
  if (!/\.(zip|tar\.gz|tgz)$/.test(lower)) {
    if (path.basename(source).toLowerCase() === toolName().toLowerCase()) return source;
    throw new Error('本地文件必须是 .zip / .tar.gz 压缩包，或者是 ' + toolName());
  }
  const out = path.join(tmp, 'extract');
  extract(source, out);
  const binary = findBinary(out, toolName());
  if (!binary) throw new Error('压缩包里没找到 ' + toolName());
  return binary;
}

function extract(archive, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const isZip = /\.zip$/i.test(archive);
  const attempts = [];
  if (isZip) {
    attempts.push(['tar', ['-xf', archive, '-C', dir]]);
    if (process.platform === 'win32') {
      attempts.push([
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath "' + archive + '" -DestinationPath "' + path.resolve(dir) + '" -Force'],
      ]);
    } else {
      attempts.push(['unzip', ['-o', archive, '-d', dir]]);
    }
  } else {
    attempts.push(['tar', ['-xzf', archive, '-C', dir]]);
  }
  const errors = [];
  for (const [bin, args] of attempts) {
    const run = spawnSync(bin, args, { encoding: 'utf8', timeout: 120000 });
    if (run.error) {
      errors.push(bin + ': ' + run.error.message);
      continue;
    }
    if (run.status === 0) {
      log('解压完成（' + bin + '）');
      return true;
    }
    errors.push(bin + ': exit ' + run.status + ' ' + String(run.stderr || '').slice(0, 200));
  }
  throw new Error('解压失败：' + errors.join(' | '));
}

/** 在解压目录里找到可执行文件（优先体积最大的同名文件）。 */
function findBinary(dir, exeName) {
  const found = [];
  const walk = (current, depth) => {
    if (depth > 6) return;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase() === exeName.toLowerCase()) {
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          size = 0;
        }
        found.push({ full, size });
      }
    }
  };
  walk(dir, 0);
  if (!found.length) return null;
  found.sort((a, b) => b.size - a.size);
  return found[0].full;
}

function versionOf(exe) {
  // 必须是 --version：不带参数会进入交互式 shell。
  const run = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
  const text = String((run.stdout || '') + (run.stderr || '')).trim();
  const line = text.split(/\r?\n/).find((row) => /version/i.test(row)) || text.split(/\r?\n/)[0] || '';
  const version = line.trim().slice(0, 120);
  return { ok: run.status === 0 && /v?\d+\.\d+\.\d+/.test(version), version };
}

async function run({ url, tag, local, mirrors }) {
  ensureHome();
  const toolsDir = path.join(homeDir(), 'tools');
  const tmp = path.join(toolsDir, '_dl-' + Date.now());
  fs.mkdirSync(toolsDir, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  const targetExe = path.join(toolsDir, toolName());
  try {
    let binary = null;
    let meta = null;
    let asset = null;
    let source = 'local';
    if (local) {
      job.phase = 'extracting';
      binary = installLocal(local, tmp);
    } else {
      job.phase = 'resolving';
      if (url) {
        if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
          throw new Error('自定义下载地址必须是 http(s) 链接；手上有压缩包就直接用「从本地压缩包安装」');
        }
        let name = 'aliyunpan-download';
        try {
          name = decodeURIComponent(new URL(url).pathname.split('/').pop() || name) || name;
        } catch {
          /* 保留默认名 */
        }
        asset = { name, url, size: null, mirrors };
        log('使用自定义地址：' + url);
      } else {
        log('查询 GitHub 最新发布…');
        const info = await releaseInfo(tag);
        const picked = pickAsset(info.assets);
        if (!picked) {
          throw new Error('发布 ' + (info.tag || '(latest)') + ' 里没有当前平台（' + process.platform + '/' + process.arch + '）的包');
        }
        asset = { name: picked.name, url: picked.url, size: picked.size, mirrors };
        log('发布版本 ' + info.tag + ' → ' + asset.name);
      }
      job.phase = 'downloading';
      if (!mirrors) log('直连不通会自动试镜像 ghfast.top / gh-proxy.com');
      const fetched = await fetchArchive(asset, tmp);
      meta = fetched.meta;
      source = fetched.source;
      job.phase = 'extracting';
      const head = Buffer.alloc(4);
      const fd = fs.openSync(fetched.archive, 'r');
      try {
        fs.readSync(fd, head, 0, 4, 0);
      } finally {
        fs.closeSync(fd);
      }
      const isZip = head[0] === 0x50 && head[1] === 0x4b;
      const isGzip = head[0] === 0x1f && head[1] === 0x8b;
      if (!isZip && !isGzip) throw new Error('下载到的不是压缩包（可能被网络劫持或返回了错误页）');
      const out = path.join(tmp, 'extract');
      extract(fetched.archive, out);
      binary = findBinary(out, toolName());
      if (!binary) throw new Error('压缩包里没找到 ' + toolName());
    }
    fs.copyFileSync(binary, targetExe);
    try {
      fs.chmodSync(targetExe, 0o755);
    } catch {
      /* Windows 忽略权限位 */
    }
    job.phase = 'verifying';
    const ver = versionOf(targetExe);
    if (!ver.ok) throw new Error('安装后试跑失败（aliyunpan --version 没输出合法版本号）：' + (ver.version || '无输出'));
    log('试跑通过：' + ver.version);
    writeConfig({ aliyunpanExe: targetExe });
    log('已写入配置 aliyunpanExe=' + targetExe);
    rmrf(tmp);
    job.phase = 'done';
    job.result = {
      ok: true,
      exe: targetExe,
      asset: asset ? asset.name : path.basename(binary),
      source,
      bytes: meta ? meta.bytes : (fs.existsSync(targetExe) ? fs.statSync(targetExe).size : 0),
      sha256: meta ? meta.sha256 : '',
      version: ver.version,
    };
    log('安装完成');
    return job.result;
  } catch (error) {
    job.phase = 'failed';
    job.error = String((error && error.message) || error);
    log('失败：' + job.error);
    log('临时目录保留供排查：' + tmp);
    throw error;
  }
}

/** 启动自举安装（后台跑，进度看 provisionState）。 */
export function startProvision(options = {}) {
  if (job.running) return { ok: false, error: '正在下载安装，请稍候', state: provisionState() };
  const local = typeof options.local === 'string' ? options.local.trim() : '';
  if (local) {
    if (!fs.existsSync(localSourcePath(local))) return { ok: false, error: '本地路径不存在：' + local };
  } else if (options.url !== undefined && options.url !== '' && !/^https?:\/\//i.test(String(options.url))) {
    return { ok: false, error: '自定义下载地址必须是 http(s) 链接' };
  }
  const support = supportedPlatform();
  if (!support.osOk || !support.archOk) {
    return { ok: false, error: '当前平台暂不支持自举安装：' + process.platform + '/' + process.arch };
  }
  job.running = true;
  job.phase = 'resolving';
  job.startedAt = Date.now();
  job.finishedAt = 0;
  job.log = [];
  job.result = null;
  job.error = null;
  log('平台 ' + process.platform + '/' + process.arch + '，安装到 ' + path.join(homeDir(), 'tools'));
  run({ url: options.url, tag: options.tag, local, mirrors: options.mirrors })
    .catch(() => {})
    .finally(() => {
      job.running = false;
      job.finishedAt = Date.now();
    });
  return { ok: true, state: provisionState() };
}
