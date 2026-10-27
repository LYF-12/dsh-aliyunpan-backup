import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PKG_NAME, SYNC_DIR_CHOICES, readConfig, writeConfig, runtimeView, configPath, homeDir, syncRoots } from './config.mjs';
import { resolvePackage, startRestore, state, tailLog } from './runner.mjs';
import { cancelSync, startSync, syncState, tailSyncLog } from './syncrun.mjs';
import { planSync } from './syncplan.mjs';
import { exeStatus, provisionState, startProvision } from './provision.mjs';

/** cordis 插件名（与 cordis.patch.yml 的 insert id 一致） */
export const name = PKG_NAME;
/** 只依赖 web 服务器的路由接缝 */
export const inject = ['webServer'];

const BASE = '/api/' + PKG_NAME;

/** 页面模板：随包分发，缺失时给一个最小占位而不抛错。 */
const PAGE_HTML = (() => {
  try {
    return fs.readFileSync(new URL('./ui.html', import.meta.url), 'utf8');
  } catch {
    return '<!doctype html><meta charset="utf-8"><h1>dsh-aliyunpan-backup</h1><p>ui.html 缺失，请重装插件。</p>';
  }
})();

function isLoopback(req) {
  const raw = (req.socket && req.socket.remoteAddress) || '';
  const addr = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  return addr === '127.0.0.1' || addr === '::1' || addr === 'localhost' || addr === '';
}

function sendJson(res, status, value) {
  const text = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(text);
}

async function readBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        resolve({});
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/** 只接受白名单字段，避免页面写坏配置。 */
function sanitizeConfig(input) {
  const patch = {};
  const take = (key, check) => {
    if (Object.hasOwn(input, key) && check(input[key])) patch[key] = input[key];
  };
  take('stagingDir', (v) => typeof v === 'string');
  take('aliyunpanExe', (v) => typeof v === 'string');
  // 自举安装的自定义下载地址（国内镜像 / 内网文件服务器），留空走 GitHub 官方发布。
  take('aliyunpanUrl', (v) => typeof v === 'string' && (v === '' || /^https?:\/\//i.test(v)));
  take('keyFile', (v) => typeof v === 'string');
  take('dshHome', (v) => typeof v === 'string' && v.trim() !== '');
  take('restoreDir', (v) => typeof v === 'string');
  // ---- 同步 ----
  take('syncDir', (v) => typeof v === 'string' && v.trim().startsWith('/'));
  take('syncMachine', (v) => typeof v === 'string' && v.trim().length <= 64);
  take('syncMode', (v) => v === 'upload' || v === 'download');
  take('syncDlDir', (v) => typeof v === 'string' && v.trim().length <= 400);
  take('syncPrune', (v) => typeof v === 'boolean');
  if (Object.hasOwn(input, 'syncDirs')) {
    // 只认白名单目录，且至少留一个，避免误把整个 .dsh（含 node_modules）拖上云。
    const list = Array.isArray(input.syncDirs) ? input.syncDirs.filter((n) => SYNC_DIR_CHOICES.includes(n)) : [];
    if (list.length) patch.syncDirs = [...new Set(list)];
  }
  if (Object.hasOwn(input, 'syncLockMinutes')) {
    const n = Number(input.syncLockMinutes);
    if (Number.isFinite(n) && n >= 0 && n <= 1440) patch.syncLockMinutes = Math.round(n);
  }
  return patch;
}

/** 扫描本地可解码的包：暂存目录 snapshots 下每个含 payload.enc 的子目录 + 暂存根目录本身。 */
function listPackages() {
  const view = runtimeView();
  const roots = [path.join(view.stagingDir, 'snapshots'), view.stagingDir];
  const seen = new Set();
  const out = [];
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      if (seen.has(dir)) continue;
      seen.add(dir);
      const enc = path.join(dir, 'payload.enc');
      let bytes = 0;
      let mtime = null;
      try {
        const st = fs.statSync(enc);
        if (!st.isFile()) continue;
        bytes = st.size;
        mtime = st.mtime.toISOString();
      } catch {
        continue;
      }
      let info = null;
      try {
        info = JSON.parse(fs.readFileSync(path.join(dir, 'package.info.json'), 'utf8'));
      } catch {
        info = null;
      }
      out.push({ id: entry.name, path: dir, bytes, mtime, info });
    }
  }
  return out.sort((a, b) => String(b.mtime || '').localeCompare(String(a.mtime || '')));
}

function serveUi(_req, res) {
  sendText(res, 200, PAGE_HTML, 'text/html; charset=utf-8');
}

function handleStatus(_req, res) {
  const view = runtimeView();
  const cfg = readConfig();
  const sync = syncState();
  const packages = listPackages();
  sendJson(res, 200, {
    ok: true,
    state: state(),
    view: { ...view, configPath: configPath(), home: homeDir() },
    sync: {
      mode: cfg.syncMode,
      dir: cfg.syncDir,
      machine: cfg.syncMachine || os.hostname(),
      running: sync.running,
      last: sync.last,
    },
    env: exeStatus(),
    provision: provisionSummary(),
    packages: packages.slice(0, 20),
    // 兼容旧页面字段名
    snapshots: packages.slice(0, 20),
    log: tailLog(60),
  });
}

async function handleConfig(req, res) {
  if (req.method === 'GET') return sendJson(res, 200, { ok: true, config: readConfig(), view: runtimeView() });
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
  const body = await readBody(req);
  const patch = sanitizeConfig(body);
  if (Object.keys(patch).length === 0) return sendJson(res, 400, { ok: false, error: '没有可保存的字段' });
  const next = writeConfig(patch);
  return sendJson(res, 200, { ok: true, config: next, view: runtimeView() });
}

/** 解码：pkg 可以是本地任意路径（文件夹或 payload.enc），也可以是 snapshots 下的包名。 */
async function handleRestore(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
  const body = await readBody(req);
  const started = startRestore({
    pkg: typeof body.pkg === 'string' ? body.pkg : undefined,
    snapshot: typeof body.snapshot === 'string' ? body.snapshot : undefined,
    out: typeof body.out === 'string' ? body.out : undefined,
    passphrase: typeof body.passphrase === 'string' ? body.passphrase : undefined,
    verifyOnly: body.verifyOnly !== false,
  });
  return sendJson(res, started.ok ? 200 : 409, started);
}

/** 预检：判断路径是不是一个可解的包（页面输入框边输边提示用）。 */
function handleInspect(_req, res, url) {
  const pkg = new URL(url, 'http://127.0.0.1').searchParams.get('pkg') || '';
  const resolved = resolvePackage(pkg);
  if (!resolved.ok) {
    return sendJson(res, 200, { ok: true, found: false, path: resolved.target || '', hint: '这个位置没有 payload.enc' });
  }
  const enc = path.join(resolved.target, 'payload.enc');
  const st = fs.statSync(enc);
  let info = null;
  try {
    info = JSON.parse(fs.readFileSync(path.join(resolved.target, 'package.info.json'), 'utf8'));
  } catch {
    info = null;
  }
  return sendJson(res, 200, { ok: true, found: true, path: resolved.target, bytes: st.size, mtime: st.mtime.toISOString(), info });
}

function handleLog(req, res, url) {
  const limit = Number(new URL(url, 'http://127.0.0.1').searchParams.get('lines') || '200');
  const lines = Number.isFinite(limit) ? Math.max(1, Math.min(2000, limit)) : 200;
  const tail = tailLog(lines);
  return sendJson(res, 200, { ok: true, ...tail });
}

const KEY_MIN = 8;
const KEY_MAX = 200;

/** 读取当前口令文件（不主动创建）。 */
function readKey() {
  const file = runtimeView().keyFile;
  let key = '';
  let mtime = null;
  let exists = false;
  try {
    const st = fs.statSync(file);
    exists = true;
    mtime = st.mtime.toISOString();
    key = fs.readFileSync(file, 'utf8').trim();
  } catch {
    /* 还没有口令文件 */
  }
  const masked = key ? key.slice(0, 4) + '…' + key.slice(-4) : '';
  return { file, exists, length: key.length, masked, mtime, key };
}

function writeKey(text) {
  const file = runtimeView().keyFile;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 换口令前把旧口令留一份 KEY.txt.bak：误换/误覆盖时还能找回打开旧包的钥匙。
  try {
    if (fs.existsSync(file)) {
      const prev = fs.readFileSync(file, 'utf8').trim();
      if (prev && prev !== text) fs.writeFileSync(file + '.bak', prev + '\n', { encoding: 'utf8', mode: 0o600 });
    }
  } catch {
    /* 备份失败不阻塞写入 */
  }
  fs.writeFileSync(file, text + '\n', { encoding: 'utf8', mode: 0o600 });
  return file;
}

function keySummary(extra = {}) {
  const k = readKey();
  let backup = false;
  try {
    backup = fs.existsSync(k.file + '.bak');
  } catch {
    /* ignore */
  }
  return { ok: true, keyFile: k.file, backupFile: k.file + '.bak', backup, exists: k.exists, length: k.length, masked: k.masked, mtime: k.mtime, usable: k.length >= KEY_MIN, ...extra };
}

/** 口令管理：GET 看状态（reveal=1 才回明文），POST 写口令 / 生成新口令。 */
async function handleKey(req, res, url) {
  if (req.method === 'GET') {
    const reveal = new URL(url, 'http://127.0.0.1').searchParams.get('reveal') === '1';
    return sendJson(res, 200, keySummary(reveal ? { key: readKey().key } : {}));
  }
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
  const body = await readBody(req);
  if (body.generate === true) {
    if (readKey().exists && body.force !== true) {
      return sendJson(res, 409, {
        ok: false,
        error: '已有口令：换成新口令后，用旧口令打的包需要手动输入旧口令才能解。确实要换请带上 force=true。',
        ...keySummary(),
      });
    }
    const next = crypto.randomBytes(24).toString('base64url');
    const file = writeKey(next);
    return sendJson(res, 200, keySummary({ keyFile: file, generated: true, key: next }));
  }
  const pass = typeof body.passphrase === 'string' ? body.passphrase.trim() : '';
  if (pass.length < KEY_MIN || pass.length > KEY_MAX) {
    return sendJson(res, 400, { ok: false, error: `口令长度需在 ${KEY_MIN}–${KEY_MAX} 个字符之间` });
  }
  if (/[\r\n]/.test(pass)) return sendJson(res, 400, { ok: false, error: '口令不能包含换行' });
  const file = writeKey(pass);
  return sendJson(res, 200, keySummary({ keyFile: file, saved: true }));
}

/** 同步状态：方向、范围、机器标识、上次结果、日志尾。 */
function handleSync(_req, res) {
  const cfg = readConfig();
  const view = runtimeView();
  const roots = syncRoots(cfg).map((root) => ({
    ...root,
    exists: fs.existsSync(root.local),
  }));
  return sendJson(res, 200, {
    ok: true,
    state: syncState(),
    dir: cfg.syncDir,
    mode: cfg.syncMode,
    machine: cfg.syncMachine || os.hostname(),
    lockMinutes: cfg.syncLockMinutes,
    dlDir: view.syncDlDir,
    prune: cfg.syncPrune,
    choices: SYNC_DIR_CHOICES,
    dirs: roots,
    config: view,
    log: tailSyncLog(120),
  });
}

/** 预演：只统计本地每个目录的文件数 / 体积，不动云端也不写本地。 */
function handleSyncPlan(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
  const plan = planSync();
  return sendJson(res, 200, { ok: true, plan });
}

async function handleSyncRun(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
  const body = await readBody(req);
  const mode = typeof body.mode === 'string' ? body.mode : readConfig().syncMode;
  if (mode !== 'upload' && mode !== 'download') return sendJson(res, 400, { ok: false, error: '未知同步模式: ' + mode });
  const started = startSync(mode);
  return sendJson(res, started.ok ? 200 : 409, started);
}

function handleSyncCancel(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
  return sendJson(res, 200, cancelSync());
}

/** 只给卡片用的精简状态，避免把 160 行日志塞进每次轮询。 */
function provisionSummary() {
  const state = provisionState();
  return {
    running: state.running,
    phase: state.phase,
    installed: state.installed,
    exe: state.exe,
    target: state.target,
    managed: state.managed,
    supported: state.supported,
    error: state.error,
    version: state.result ? state.result.version : '',
    lastLog: state.log.slice(-3),
  };
}

function handleProvision(req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
  return sendJson(res, 200, { ok: true, ...provisionState() });
}

async function handleProvisionRun(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
  const body = await readBody(req);
  const explicit = typeof body.url === 'string' ? body.url.trim() : '';
  const configured = readConfig().aliyunpanUrl || '';
  const url = explicit || configured || undefined;
  const started = startProvision({ url, tag: typeof body.tag === 'string' ? body.tag : undefined });
  // 自定义地址顺手记住，下次不用再填（显式传空字符串可清除）。
  if (explicit && explicit !== configured) {
    try {
      writeConfig({ aliyunpanUrl: explicit });
    } catch {
      /* 记住地址失败不影响本次安装 */
    }
  }
  return sendJson(res, started.ok ? 200 : 409, { ...started, provision: provisionSummary() });
}

function routes() {
  return [
    { kind: 'exact', path: BASE + '/ui', handler: serveUi },
    { kind: 'exact', path: BASE + '/status', handler: handleStatus },
    { kind: 'exact', path: BASE + '/config', handler: handleConfig },
    { kind: 'exact', path: BASE + '/restore', handler: handleRestore },
    { kind: 'exact', path: BASE + '/inspect', handler: handleInspect },
    { kind: 'exact', path: BASE + '/key', handler: handleKey },
    { kind: 'exact', path: BASE + '/log', handler: handleLog },
    { kind: 'exact', path: BASE + '/sync', handler: handleSync },
    { kind: 'exact', path: BASE + '/sync/plan', handler: handleSyncPlan },
    { kind: 'exact', path: BASE + '/sync/run', handler: handleSyncRun },
    { kind: 'exact', path: BASE + '/sync/cancel', handler: handleSyncCancel },
    { kind: 'exact', path: BASE + '/provision', handler: handleProvision },
    { kind: 'exact', path: BASE + '/provision/run', handler: handleProvisionRun },
  ];
}

const handler = (fn) => (req, res) => {
  if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'forbidden: loopback-only' });
  return Promise.resolve(fn(req, res, req.url)).catch((error) =>
    sendJson(res, 500, { ok: false, error: String((error && error.message) || error) }),
  );
};

export function apply(ctx) {
  ctx.effect(() => {
    const disposers = routes().map((route) => ctx.webServer.register({ ...route, handler: handler(route.handler) }));
    return () => {
      for (const dispose of disposers) if (typeof dispose === 'function') dispose();
    };
  }, 'dsh-aliyunpan-backup: http routes');
}
