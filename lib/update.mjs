import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PKG_NAME, readConfig } from './config.mjs';
import { describeError, downloadSources } from './provision.mjs';

/** 本包安装目录（lib/ 的上一级）：github: 安装指向 profile 的 node_modules，link: 指向开发目录。 */
const SELF_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function selfPkg() {
  return readJson(path.join(SELF_ROOT, 'package.json')) || {};
}

export function currentVersion() {
  return String(selfPkg().version || '0.0.0');
}

/**
 * 本进程启动时加载进去的版本。
 * 更新只换磁盘上的文件，内存里的代码还是旧的，所以「当前版本」要记住这个值，
 * 否则更新完成后再读 package.json 会看到新版本，误显示「已是最新、不用重启」。
 */
const LOADED_VERSION = currentVersion();

/** 上游仓库（从 package.json 的 repository 字段解析）。 */
function repoSlug() {
  const pkg = selfPkg();
  const repo = pkg.repository;
  const url = String((repo && repo.url) || repo || pkg.homepage || '');
  const m = /github\.com[\/:]([^\/\s]+)\/([^\/\s#]+)/.exec(url);
  return m ? (m[1] + '/' + m[2]).replace(/\.git$/, '') : '';
}

/** DSH 数据根目录：DSH_HOME > 配置里的 dshHome > ~/.dsh */
function dshRoot() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  const cfg = readConfig();
  return cfg.dshHome || path.join(os.homedir(), '.dsh');
}

/** 解析 package.json 里的依赖写法。 */
function parseSpec(spec, profileDir) {
  const raw = String(spec || '').trim();
  if (!raw) return null;
  if (raw.startsWith('link:')) {
    const target = raw.slice(5);
    return { kind: 'link', target: path.isAbsolute(target) ? target : path.resolve(profileDir, target), spec: raw };
  }
  const gh = /^github:([^#]+)(?:#(.+))?$/.exec(raw) || /github\.com[\/:]([^#]+?)(?:\.git)?(?:#(.+))?$/.exec(raw);
  if (gh) return { kind: 'github', repo: gh[1].replace(/\.git$/, ''), ref: gh[2] || '', spec: raw };
  if (raw.startsWith('file:')) return { kind: 'file', target: raw.slice(5), spec: raw };
  return { kind: 'registry', spec: raw };
}

function readVersionAt(dir) {
  if (!dir) return '';
  const pkg = readJson(path.join(dir, 'package.json'));
  return pkg ? String(pkg.version || '') : '';
}

/**
 * 正在运行的是哪个 profile。
 * 顺序：本进程代码所在目录 > 路径里含 /profiles/<名字>/ > DSH_PROFILE > 第一个。
 * 不能先看 DSH_PROFILE：宿主会给所有子进程注入同一个值，测试实例或 --profile 覆盖时会认错人。
 */
function runningProfile(list) {
  const same = (a) => {
    if (!a) return false;
    try {
      return path.resolve(a).toLowerCase() === path.resolve(SELF_ROOT).toLowerCase();
    } catch {
      return false;
    }
  };
  const byReal = list.find((i) => same(i.realDir) || same(i.target));
  if (byReal) return byReal.profile;
  const norm = SELF_ROOT.replace(/\\/g, '/');
  const m = /\/profiles\/([^/]+)\//.exec(norm);
  if (m && list.some((i) => i.profile === m[1])) return m[1];
  const env = String(process.env.DSH_PROFILE || process.env.DSH_PROFILE_NAME || '').trim();
  if (env && list.some((i) => i.profile === env)) return env;
  return list.length ? list[0].profile : '';
}

/** 扫描所有装了本插件的 profile。 */
export function installs() {
  const base = path.join(dshRoot(), 'profiles');
  let names = [];
  try {
    names = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    names = [];
  }
  const out = [];
  for (const name of names.sort()) {
    const dir = path.join(base, name);
    const pkg = readJson(path.join(dir, 'package.json'));
    if (!pkg) continue;
    const spec = (pkg.dependencies && pkg.dependencies[PKG_NAME]) || (pkg.devDependencies && pkg.devDependencies[PKG_NAME]) || '';
    if (!spec) continue;
    const parsed = parseSpec(spec, dir) || { kind: 'unknown', spec };
    const nm = path.join(dir, 'node_modules', PKG_NAME);
    let realDir = '';
    try {
      realDir = fs.realpathSync(nm);
    } catch {
      realDir = '';
    }
    let version = readVersionAt(realDir);
    if (!version && parsed.target) version = readVersionAt(parsed.target);
    out.push({
      profile: name,
      dir,
      spec,
      kind: parsed.kind,
      target: parsed.target || '',
      repo: parsed.repo || '',
      ref: parsed.ref || '',
      realDir,
      version,
      active: false,
    });
  }
  const running = runningProfile(out);
  for (const inst of out) inst.active = inst.profile === running;
  return out;
}

function parseVer(value) {
  return String(value || '').replace(/^v/i, '').split(/[.+-]/).map((part) => parseInt(part, 10) || 0);
}

export function compareVersions(a, b) {
  const pa = parseVer(a);
  const pb = parseVer(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

async function fetchText(url, headers, ms = 15000) {
  const res = await fetch(url, {
    headers: Object.assign({ 'user-agent': 'dsh-' + PKG_NAME }, headers || {}),
    signal: AbortSignal.timeout(ms),
  });
  const text = await res.text();
  if (!res.ok) {
    const error = new Error('HTTP ' + res.status);
    error.status = res.status;
    throw error;
  }
  return text;
}

/** 查上游 package.json 的版本：官方 API → raw → 两个镜像。 */
async function remoteVersion(slug, ref) {
  const useRef = ref || 'main';
  const raw = 'https://raw.githubusercontent.com/' + slug + '/' + useRef + '/package.json';
  const targets = [
    { name: 'GitHub API', url: 'https://api.github.com/repos/' + slug + '/contents/package.json?ref=' + encodeURIComponent(useRef), headers: { accept: 'application/vnd.github.raw+json' } },
    { name: 'raw.githubusercontent.com', url: raw },
    { name: '镜像 ghfast.top', url: 'https://ghfast.top/' + raw },
    { name: '镜像 gh-proxy.com', url: 'https://gh-proxy.com/' + raw },
  ];
  const errors = [];
  for (const target of targets) {
    try {
      const pkg = JSON.parse(await fetchText(target.url, target.headers));
      if (pkg && pkg.version) return { version: String(pkg.version), source: target.name };
    } catch (error) {
      errors.push(target.name + '：' + describeError(error));
    }
  }
  throw new Error('查不到最新版本（' + errors.join('；') + '）');
}

const state = {
  current: '',
  latest: '',
  latestSource: '',
  behind: false,
  checking: false,
  checkedAt: '',
  error: '',
  installs: [],
  runningProfile: '',
  pendingRestart: false,
  installedVersion: '',
  running: false,
  phase: 'idle',
  log: [],
  result: null,
};

function log(line) {
  state.log.push(new Date().toISOString().slice(11, 19) + ' ' + line);
  if (state.log.length > 400) state.log.splice(0, state.log.length - 400);
}

export function updateState() {
  return Object.assign({}, state, { current: LOADED_VERSION, log: state.log.slice(-150) });
}

/** 卡片用精简摘要（每次都读一次磁盘，版本可能已经被手工改动）。 */
export function updateSummary() {
  const list = installs();
  const primary = list.find((i) => i.active) || list[0];
  const installed = primary ? primary.version : '';
  const current = LOADED_VERSION;
  return {
    current,
    installed,
    latest: state.latest || '',
    behind: state.behind === true,
    pendingRestart:
      state.pendingRestart === true || (installed !== '' && compareVersions(installed, LOADED_VERSION) > 0),
    running: state.running === true,
    phase: state.phase,
    checkedAt: state.checkedAt,
    profiles: list.map((i) => i.profile),
    error: state.error,
  };
}

export async function checkUpdate() {
  const list = installs();
  state.installs = list.map((i) => ({
    profile: i.profile,
    spec: i.spec,
    kind: i.kind,
    version: i.version,
    active: i.active,
    dir: i.dir,
    realDir: i.realDir,
    target: i.target,
    repo: i.repo,
  }));
  state.runningProfile = runningProfile(list) || '';
  state.current = LOADED_VERSION;
  state.checking = true;
  state.error = '';
  try {
    const primary = list.find((i) => i.active) || list[0];
    const slug = (primary && primary.repo) || repoSlug();
    if (!slug) throw new Error('不知道上游仓库地址（package.json 的 repository 为空）');
    const info = await remoteVersion(slug, (primary && primary.ref) || 'main');
    state.latest = info.version;
    state.latestSource = info.source;
    const onDisk = (primary && primary.version) || LOADED_VERSION;
    state.installedVersion = onDisk;
    state.behind = compareVersions(info.version, onDisk) > 0;
    state.pendingRestart = Boolean(onDisk && compareVersions(onDisk, LOADED_VERSION) > 0);
    state.checkedAt = new Date().toISOString();
  } catch (error) {
    state.error = String((error && error.message) || error);
  } finally {
    state.checking = false;
  }
  return updateState();
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      return reject(new Error('无法启动 ' + command + '：' + describeError(error)));
    }
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      out += chunk.toString('utf8');
    });
    child.on('error', (error) => reject(new Error('无法启动 ' + command + '：' + describeError(error))));
    child.on('close', (code) => {
      const text = out.trim();
      if (code === 0) return resolve(text);
      const tail = text ? '：' + text.split(/\r?\n/).filter(Boolean).slice(-3).join(' ') : '';
      reject(new Error(command + ' 退出码 ' + code + tail));
    });
  });
}

async function fetchToFile(url, dest) {
  const res = await fetch(url, { headers: { 'user-agent': 'dsh-' + PKG_NAME }, signal: AbortSignal.timeout(180000) });
  if (!res.ok) {
    const error = new Error('HTTP ' + res.status);
    error.retryable = res.status === 408 || res.status === 429 || res.status >= 500;
    throw error;
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buffer);
  return buffer.length;
}

/** 下载：官方直连 + 镜像，每个源最多 2 次。 */
async function downloadTo(url, dest, logFn) {
  const sources = downloadSources(url);
  const errors = [];
  for (const source of sources) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        logFn('下载源 ' + source.name + (attempt > 1 ? '（第 ' + attempt + ' 次）' : ''));
        const size = await fetchToFile(source.url, dest);
        if (!size) throw new Error('下载到 0 字节');
        return { size, source: source.name };
      } catch (error) {
        const msg = describeError(error);
        errors.push(source.name + '：' + msg);
        logFn('下载失败（' + source.name + '）：' + msg);
        try {
          fs.rmSync(dest, { force: true });
        } catch {
          /* 半截文件删不掉不影响换源 */
        }
        if (error && error.retryable === false) break;
      }
    }
  }
  throw new Error('所有下载源都失败 → ' + errors.join('；'));
}

function findPackageRoot(dir) {
  const queue = [dir];
  for (let depth = 0; depth < 4; depth += 1) {
    const next = [];
    for (const current of queue) {
      const pkg = readJson(path.join(current, 'package.json'));
      if (pkg && pkg.name === PKG_NAME) return current;
      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        entries = [];
      }
      for (const entry of entries) if (entry.isDirectory()) next.push(path.join(current, entry.name));
    }
    queue.length = 0;
    queue.push(...next);
  }
  return '';
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(src), dst);
    else fs.copyFileSync(src, dst);
  }
}

/** 原子替换目录：新目录就位失败时把旧目录换回来。 */
function swapDir(next, target) {
  const backup = target + '.old-' + Date.now();
  fs.renameSync(target, backup);
  try {
    fs.renameSync(next, target);
  } catch (error) {
    fs.renameSync(backup, target);
    throw error;
  }
  try {
    fs.rmSync(backup, { recursive: true, force: true });
  } catch {
    /* 备份删不掉不影响新版本使用 */
  }
}

async function updateLink(inst) {
  state.phase = 'installing';
  const target = inst.target || inst.realDir;
  if (!target) throw new Error('拿不到这个安装对应的本地目录');
  if (!fs.existsSync(path.join(target, '.git'))) {
    throw new Error('这个安装指向本地目录（link:）但没有 .git，无法自动更新；请在 ' + target + ' 手动 git pull');
  }
  log('git pull --ff-only：' + target);
  const out = await run('git', ['-C', target, 'pull', '--ff-only'], target);
  log(out || '（git 无输出）');
  return readVersionAt(target);
}

async function updateGithub(inst) {
  const slug = inst.repo || repoSlug();
  if (!slug) throw new Error('不知道上游仓库地址');
  const ref = inst.ref || 'main';
  const dir = inst.realDir || path.join(inst.dir, 'node_modules', PKG_NAME);
  if (!fs.existsSync(dir)) throw new Error('安装目录不存在：' + dir);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-update-'));
  try {
    const archive = path.join(work, 'src.tar.gz');
    const url = 'https://github.com/' + slug + '/archive/refs/heads/' + ref + '.tar.gz';
    log('下载 ' + url);
    const got = await downloadTo(url, archive, log);
    log('下载完成（' + got.source + '，' + (got.size / 1024).toFixed(0) + ' KB）');
    const unpacked = path.join(work, 'src');
    fs.mkdirSync(unpacked, { recursive: true });
    state.phase = 'installing';
    await run('tar', ['-xzf', archive, '-C', unpacked]);
    const root = findPackageRoot(unpacked);
    if (!root) throw new Error('压缩包里没有找到 ' + PKG_NAME + '/package.json');
    const next = path.join(work, 'next');
    copyDir(root, next);
    const deps = path.join(dir, 'node_modules');
    if (fs.existsSync(deps)) fs.renameSync(deps, path.join(next, 'node_modules'));
    swapDir(next, dir);
    log('已替换安装目录：' + dir);
    return readVersionAt(dir);
  } finally {
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch {
      /* 临时目录残留不影响使用 */
    }
  }
}

async function updateOne(inst) {
  if (inst.kind === 'link') return updateLink(inst);
  if (inst.kind === 'github') return updateGithub(inst);
  throw new Error('这个安装方式（' + inst.kind + '）不支持插件内自动更新；请用包管理器更新：' + (inst.spec || ''));
}

async function runUpdate(targets) {
  let version = '';
  for (const inst of targets) {
    log('→ ' + inst.profile + '（' + inst.kind + '：' + inst.spec + '）');
    try {
      version = await updateOne(inst);
      log('完成：' + inst.profile + ' → ' + (version || '版本未知'));
    } catch (error) {
      const msg = String((error && error.message) || error);
      state.phase = 'failed';
      state.error = msg;
      log('失败：' + inst.profile + ' → ' + msg);
      throw error;
    }
  }
  state.installedVersion = version;
  state.phase = 'done';
  const newer = version && compareVersions(version, LOADED_VERSION) > 0;
  state.pendingRestart = Boolean(newer);
  state.result = '已更新到 ' + (version || '?') + (newer ? '，重启 DSH 后生效' : '（版本没变，已是最新）');
  log(state.result);
  try {
    await checkUpdate();
  } catch {
    /* 更新已完成，复查失败不影响结论 */
  }
}

export function startUpdate(options = {}) {
  if (state.running) return { ok: false, error: '已经在更新了，等这一次跑完' };
  const list = installs();
  const wanted = typeof options.profile === 'string' ? options.profile.trim() : '';
  let targets = wanted ? list.filter((i) => i.profile === wanted) : list.filter((i) => i.active);
  if (!targets.length && !wanted) targets = list;
  if (!targets.length) {
    return { ok: false, error: '没找到装了本插件的 profile（profile 的 package.json 里没有 ' + PKG_NAME + ' 依赖）' };
  }
  state.running = true;
  state.phase = 'checking';
  state.error = '';
  state.result = null;
  state.log = [];
  log('目标 profile：' + targets.map((i) => i.profile).join('、'));
  runUpdate(targets)
    .catch((error) => {
      state.phase = 'failed';
      state.error = String((error && error.message) || error);
    })
    .finally(() => {
      state.running = false;
    });
  return { ok: true, profiles: targets.map((i) => i.profile) };
}
