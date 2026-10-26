import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { childEnv, ensureHome, keyFile, readConfig, stagingDir } from './config.mjs';

const SCRIPTS = (name) => new URL('./scripts/' + name, import.meta.url);

let child = null;
let job = null;

function logPath() {
  return path.join(stagingDir(readConfig()), 'last-run.log');
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

/**
 * 启动一次备份任务。
 * mode: 'upload' | 'verify'（只打包校验，不上传）| 'dry-run'
 */
export function startRun(mode = 'upload') {
  if (child !== null) return { ok: false, error: '已有任务在运行', job: { ...job } };
  const cfg = readConfig();
  ensureHome();
  // 新机器上暂存目录还不存在：spawn 的 cwd 不能指向不存在的目录，否则 exit=null/ENOENT。
  fs.mkdirSync(stagingDir(cfg), { recursive: true });
  const p = logPath();
  truncateLog(p);
  const out = fs.openSync(p, 'a');
  const args = [SCRIPTS('sync.mjs').pathname.replace(/^\/([A-Za-z]:)/, '$1')];
  if (mode === 'verify') args.push('--no-upload');
  if (mode === 'dry-run') args.push('--dry-run');
  if (!cfg.includeFeishuFiles) args.push('--no-feishu-files');
  args.push('--keep', String(cfg.keep));

  const startedAt = new Date().toISOString();
  job = { mode, startedAt, finishedAt: null, exitCode: null, phase: 'spawn', result: null };
  try {
    child = spawn(process.execPath, args, {
      cwd: stagingDir(cfg),
      env: childEnv(),
      windowsHide: true,
      stdio: ['ignore', out, out],
    });
  } catch (error) {
    fs.closeSync(out);
    child = null;
    job.finishedAt = new Date().toISOString();
    job.phase = 'failed';
    job.result = String((error && error.message) || error);
    return { ok: false, error: job.result };
  }
  const thisChild = child;
  thisChild.on('exit', (code) => {
    try {
      fs.closeSync(out);
    } catch {
      /* 已关闭 */
    }
    const t = tailLog(400).text;
    const m = /RESULT:.*/i.exec(t);
    job.finishedAt = new Date().toISOString();
    job.exitCode = code;
    job.phase = code === 0 ? 'done' : 'failed';
    job.result = m ? m[0].trim() : 'exit=' + code;
    child = null;
  });
  thisChild.on('error', (error) => {
    job.finishedAt = new Date().toISOString();
    job.phase = 'failed';
    job.result = String((error && error.message) || error);
    child = null;
  });
  return { ok: true, pid: thisChild.pid, job: { ...job } };
}

export function cancelRun() {
  if (child === null) return { ok: false, error: '没有正在运行的任务' };
  const pid = child.pid;
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  return { ok: true, pid };
}

/** 恢复：从本地快照解包（或仅校验）。 */
export function startRestore({ snapshot, out, verifyOnly } = {}) {
  if (child !== null) return { ok: false, error: '已有任务在运行' };
  const cfg = readConfig();
  const staging = stagingDir(cfg);
  const snapshots = path.join(staging, 'snapshots');
  let target = snapshot;
  if (!target) {
    const ids = fs.existsSync(snapshots)
      ? fs.readdirSync(snapshots).filter((d) => /^\d{8}T\d{4}-full$/.test(d)).sort()
      : [];
    target = ids.length ? path.join(snapshots, ids[ids.length - 1]) : '';
  } else if (!path.isAbsolute(target)) {
    target = path.join(snapshots, target);
  }
  if (!target || !fs.existsSync(path.join(target, 'payload.enc'))) {
    return { ok: false, error: '找不到快照：' + (target || '(无)') };
  }
  ensureHome();
  fs.mkdirSync(staging, { recursive: true });
  const p = logPath();
  truncateLog(p);
  const fd = fs.openSync(p, 'a');
  const keyPath = keyFile(cfg);
  if (!fs.existsSync(keyPath)) {
    return {
      ok: false,
      error: '口令文件不存在：' + keyPath + '\n换电脑时请在配置页「口令」里粘贴旧机器的口令，或把旧 KEY.txt 拷到该路径。',
    };
  }
  const args = [SCRIPTS('restore.mjs').pathname.replace(/^\/([A-Za-z]:)/, '$1'), '--pkg', target, '--key', keyPath];
  // 解包必须给 --out：页面只传 {snapshot, verifyOnly:false}，这里补默认目录，否则子进程直接 exit=2。
  let outDir = '';
  if (verifyOnly !== false) args.push('--verify-only');
  else {
    outDir = out || cfg.restoreDir || path.join(staging, 'restore', path.basename(target));
    args.push('--out', outDir);
  }
  job = { mode: verifyOnly === false ? 'restore' : 'restore-verify', outDir, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, phase: 'spawn', result: null };
  try {
    child = spawn(process.execPath, args, { cwd: staging, env: childEnv(), windowsHide: true, stdio: ['ignore', fd, fd] });
  } catch (error) {
    try { fs.closeSync(fd); } catch {}
    child = null;
    return { ok: false, error: String((error && error.message) || error) };
  }
  const thisChild = child;
  thisChild.on('exit', (code) => {
    try { fs.closeSync(fd); } catch {}
    const t = tailLog(400).text;
    const m = /verify: ok=.*|extracted=.*/i.exec(t);
    job.finishedAt = new Date().toISOString();
    job.exitCode = code;
    job.phase = code === 0 ? 'done' : 'failed';
    job.result = m ? m[0].trim() : 'exit=' + code;
    child = null;
  });
  thisChild.on('error', (error) => {
    job.finishedAt = new Date().toISOString();
    job.phase = 'failed';
    job.result = String((error && error.message) || error);
    child = null;
  });
  return { ok: true, pid: thisChild.pid, target, outDir };
}
