import fs from 'node:fs';
import path from 'node:path';
import { PKG_NAME, readConfig, writeConfig, runtimeView, configPath, homeDir } from './config.mjs';
import { cancelRun, startRestore, startRun, state, tailLog } from './runner.mjs';

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
  take('remoteDir', (v) => typeof v === 'string' && v.trim().startsWith('/'));
  take('aliyunpanExe', (v) => typeof v === 'string');
  take('keyFile', (v) => typeof v === 'string');
  take('dshHome', (v) => typeof v === 'string' && v.trim() !== '');
  take('restoreDir', (v) => typeof v === 'string');
  take('includeFeishuFiles', (v) => typeof v === 'boolean');
  if (Object.hasOwn(input, 'keep')) {
    const n = Number(input.keep);
    if (Number.isFinite(n) && n >= 0 && n <= 50) patch.keep = Math.round(n);
  }
  return patch;
}

function listSnapshots() {
  const view = runtimeView();
  const dir = path.join(view.stagingDir, 'snapshots');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d{8}T\d{4}-full$/.test(entry.name)) continue;
    const enc = path.join(dir, entry.name, 'payload.enc');
    let bytes = 0;
    let mtime = null;
    try {
      const st = fs.statSync(enc);
      bytes = st.size;
      mtime = st.mtime.toISOString();
    } catch {
      continue;
    }
    out.push({ id: entry.name, bytes, mtime });
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : -1));
}

function serveUi(_req, res) {
  sendText(res, 200, PAGE_HTML, 'text/html; charset=utf-8');
}

function handleStatus(_req, res) {
  const view = runtimeView();
  const pkgLatest = listSnapshots().slice(0, 5);
  sendJson(res, 200, {
    ok: true,
    state: state(),
    view: { ...view, configPath: configPath(), home: homeDir() },
    snapshots: pkgLatest,
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

async function handleRun(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
  const body = await readBody(req);
  const mode = typeof body.mode === 'string' ? body.mode : 'upload';
  if (!['upload', 'verify', 'dry-run'].includes(mode)) return sendJson(res, 400, { ok: false, error: '未知模式: ' + mode });
  const started = startRun(mode);
  return sendJson(res, started.ok ? 200 : 409, started);
}

function handleCancel(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
  return sendJson(res, 200, cancelRun());
}

async function handleRestore(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
  const body = await readBody(req);
  const started = startRestore({
    snapshot: typeof body.snapshot === 'string' ? body.snapshot : undefined,
    out: typeof body.out === 'string' ? body.out : undefined,
    verifyOnly: body.verifyOnly !== false,
  });
  return sendJson(res, started.ok ? 200 : 409, started);
}

function handleLog(req, res, url) {
  const limit = Number(new URL(url, 'http://127.0.0.1').searchParams.get('lines') || '200');
  const lines = Number.isFinite(limit) ? Math.max(1, Math.min(2000, limit)) : 200;
  const tail = tailLog(lines);
  return sendJson(res, 200, { ok: true, ...tail });
}

function routes() {
  return [
    { kind: 'exact', path: BASE + '/ui', handler: serveUi },
    { kind: 'exact', path: BASE + '/status', handler: handleStatus },
    { kind: 'exact', path: BASE + '/config', handler: handleConfig },
    { kind: 'exact', path: BASE + '/run', handler: handleRun },
    { kind: 'exact', path: BASE + '/cancel', handler: handleCancel },
    { kind: 'exact', path: BASE + '/restore', handler: handleRestore },
    { kind: 'exact', path: BASE + '/log', handler: handleLog },
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
