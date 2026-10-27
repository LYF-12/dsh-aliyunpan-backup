import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { childEnv, ensureHome, keyFile, readConfig, stagingDir } from './config.mjs';

/** 只做一件事：把本地 payload.enc 包解回来（或只校验）。上传由同步链路负责。 */
const SCRIPT = new URL('./scripts/restore.mjs', import.meta.url);
const CHILD_TIMEOUT_MS = 30 * 60 * 1000;

let child = null;
let job = null;
let timer = null;

function logPath() {
  return path.join(stagingDir(readConfig()), 'last-restore.log');
}

function truncateLog(p) {
  try {
    ensureHome();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '', 'utf8');
  } catch {
    /* 日志不可写不阻塞任务 */
  }
}

export function state() {
  const cfg = readConfig();
  return {
    running: child !== null,
    job: job === null ? null : { ...job },
    logPath: logPath(),
    stagingDir: stagingDir(cfg),
    pid: child === null ? null : child.pid,
  };
}

/** 尾部日志（按行） */
export function tailLog(lines = 80) {
  const p = logPath();
  let text = '';
  try {
    const st = fs.statSync(p);
    const size = st.size;
    const want = Math.min(size, 256 * 1024);
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.allocUnsafe(want);
    fs.readSync(fd, buf, 0, want, size - want);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch {
    return { path: p, lines: [], text: '' };
  }
  const all = text.split(/\r?\n/);
  const sliced = all.slice(Math.max(0, all.length - lines));
  return { path: p, lines: sliced, text: sliced.join('\n') };
}

/** 把用户给的路径归一成「含 payload.enc 的目录」；相对名按暂存目录 snapshots 解析。 */
export function resolvePackage(input) {
  const cfg = readConfig();
  const staging = stagingDir(cfg);
  const snapshots = path.join(staging, 'snapshots');
  const raw = String(input || '').trim();
  let target = raw;
  if (!target) {
    const ids = fs.existsSync(snapshots)
      ? fs.readdirSync(snapshots, { withFileTypes: true })
          .filter((e) => e.isDirectory() && fs.existsSync(path.join(snapshots, e.name, 'payload.enc')))
          .map((e) => e.name)
          .sort()
      : [];
    target = ids.length ? path.join(snapshots, ids[ids.length - 1]) : '';
  } else if (!path.isAbsolute(target)) {
    target = path.join(snapshots, target);
  }
  if (target && fs.existsSync(target) && fs.statSync(target).isFile()) {
    // 允许直接指到文件：payload.enc 或包内的 package.info.json
    const dir = path.dirname(target);
    if (path.basename(target) === 'payload.enc') target = dir;
    else if (fs.existsSync(path.join(dir, 'payload.enc'))) target = dir;
  }
  return { target, dir: target, staging, snapshots, ok: Boolean(target) && fs.existsSync(path.join(target, 'payload.enc')) };
}

/** 解包 / 校验：pkg 可以是绝对路径、包名，或直接是 payload.enc 文件。 */
export function startRestore({ pkg, snapshot, out, verifyOnly, passphrase } = {}) {
  if (child !== null) return { ok: false, error: '已有任务在运行' };
  const cfg = readConfig();
  const resolved = resolvePackage(pkg || snapshot);
  if (!resolved.ok) {
    return {
      ok: false,
      error:
        '找不到包：' + (resolved.target || '(无)') +
        '\n需要该目录里有 payload.enc。分享/云端下载的包一般是一个文件夹（内含 payload.enc 与 package.info.json），直接把文件夹路径或 payload.enc 路径填进来即可。',
    };
  }
  const staging = resolved.staging;
  const target = resolved.target;
  const pass = typeof passphrase === 'string' ? passphrase.trim() : '';
  const keyPath = pass || keyFile(cfg);
  if (!pass && !fs.existsSync(keyPath)) {
    return {
      ok: false,
      error: '口令文件不存在：' + keyPath + '\n· 解自己机器的包：在配置页「口令」里写入口令；\n· 解别人分享的包：在解码卡片里直接填对方给的口令。',
    };
  }
  ensureHome();
  fs.mkdirSync(staging, { recursive: true });
  const p = logPath();
  truncateLog(p);
  const fd = fs.openSync(p, 'a');
  const args = [SCRIPT.pathname.replace(/^\/([A-Za-z]:)/, '$1'), '--pkg', target, '--key', keyPath];
  let outDir = '';
  if (verifyOnly !== false) args.push('--verify-only');
  else {
    outDir = out || cfg.restoreDir || path.join(staging, 'restore', path.basename(target));
    args.push('--out', outDir);
  }
  job = {
    mode: verifyOnly === false ? 'restore' : 'restore-verify',
    pkg: target,
    outDir,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    phase: 'spawn',
    result: null,
  };
  try {
    child = spawn(process.execPath, args, { cwd: staging, env: childEnv(), windowsHide: true, stdio: ['ignore', fd, fd] });
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* 已关闭 */ }
    child = null;
    job.finishedAt = new Date().toISOString();
    job.phase = 'failed';
    job.result = String((error && error.message) || error);
    return { ok: false, error: job.result };
  }
  const thisChild = child;
  const finish = (code, errorText) => {
    try { fs.closeSync(fd); } catch { /* 已关闭 */ }
    if (timer) { clearTimeout(timer); timer = null; }
    const t = tailLog(400).text;
    const m = /verify: ok=.*|extracted=.*/i.exec(t);
    job.finishedAt = new Date().toISOString();
    job.exitCode = code;
    job.phase = code === 0 ? 'done' : 'failed';
    job.result = errorText || (m ? m[0].trim() : 'exit=' + code);
    child = null;
  };
  timer = setTimeout(() => {
    try { thisChild.kill('SIGKILL'); } catch { /* ignore */ }
  }, CHILD_TIMEOUT_MS);
  if (timer.unref) timer.unref();
  thisChild.on('exit', (code) => finish(code));
  thisChild.on('error', (error) => finish(null, String((error && error.message) || error)));
  return { ok: true, pid: thisChild.pid, pkg: target, outDir };
}
