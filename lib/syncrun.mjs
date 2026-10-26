import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { childEnv, ensureHome, homeDir } from './config.mjs';

// 同步任务与「打包上传」任务分开：各自一个子进程、各自一份日志，互不干扰。
let child = null;
let job = null;

const SCRIPT = () => fileURLToPath(new URL('./scripts/syncd.mjs', import.meta.url));
export function syncLogPath() {
  return path.join(homeDir(), 'sync.log');
}
export function syncStatePath() {
  return path.join(homeDir(), 'sync-state.json');
}

function readLast() {
  try {
    return JSON.parse(fs.readFileSync(syncStatePath(), 'utf8'));
  } catch {
    return null;
  }
}

function readTail(lines) {
  const p = syncLogPath();
  let text = '';
  try {
    const size = fs.statSync(p).size;
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

export function tailSyncLog(lines = 120) {
  return readTail(lines);
}

export function syncState() {
  return {
    running: child !== null,
    job: job === null ? null : { ...job },
    logPath: syncLogPath(),
    last: readLast(),
  };
}

/** 启动一次同步。mode: 'upload'（主机）| 'download'（从机） */
export function startSync(mode = 'upload') {
  if (mode !== 'upload' && mode !== 'download') return { ok: false, error: '未知同步模式: ' + mode };
  if (child !== null) return { ok: false, error: '已有同步任务在运行', job: { ...job } };
  ensureHome();
  const p = syncLogPath();
  fs.writeFileSync(p, '', 'utf8');
  const fd = fs.openSync(p, 'a');
  const args = [SCRIPT(), '--mode', mode];
  job = { mode: 'sync-' + mode, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, phase: 'spawn', result: null };
  try {
    child = spawn(process.execPath, args, {
      cwd: homeDir(),
      env: childEnv(),
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    });
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      /* 已关闭 */
    }
    child = null;
    job.finishedAt = new Date().toISOString();
    job.phase = 'failed';
    job.result = String((error && error.message) || error);
    return { ok: false, error: job.result };
  }
  const thisChild = child;
  thisChild.on('exit', (code) => {
    try {
      fs.closeSync(fd);
    } catch {
      /* 已关闭 */
    }
    const text = readTail(400).text;
    const match = /SYNC RESULT:.*/i.exec(text);
    job.finishedAt = new Date().toISOString();
    job.exitCode = code;
    job.phase = code === 0 ? 'done' : 'failed';
    job.result = match ? match[0].trim() : 'exit=' + code;
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

export function cancelSync() {
  if (child === null) return { ok: false, error: '没有正在运行的同步任务' };
  const pid = child.pid;
  try {
    child.kill('SIGTERM');
  } catch {
    /* 进程可能已退出 */
  }
  return { ok: true, pid };
}
