import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { childEnv, ensureHome, homeDir, readConfig } from './config.mjs';

// 同步任务：一个子进程 + 一份带时间戳的日志 + 一份可跨重启读的任务状态文件。
// 卡住是这里最常见的故障（aliyunpan 在断网/云盘抽风时不退出也不输出），所以有两道看门狗：
//   ① 空闲超时：连续 N 分钟没有任何输出 → 判卡住，杀掉；
//   ② 总时长：超过 M 分钟 → 强制结束。
let child = null;
let job = null;
let orphan = null; // 上次宿主进程留下的、pid 还活着的任务
let watchdog = null;
let logStream = null;
let lastOutputMs = 0;
let killTimer = null;

const SCRIPT = () => fileURLToPath(new URL('./scripts/syncd.mjs', import.meta.url));
const JOB_FILE = 'sync-job.json';
const KILL_GRACE_MS = 5000;

export function syncLogPath() {
  return path.join(homeDir(), 'sync.log');
}
export function syncStatePath() {
  return path.join(homeDir(), 'sync-state.json');
}
export function syncJobPath() {
  return path.join(homeDir(), JOB_FILE);
}

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return '[' + p(date.getHours()) + ':' + p(date.getMinutes()) + ':' + p(date.getSeconds()) + '] ';
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
    return { path: p, lines: [], text: '', bytes: 0 };
  }
  const all = text.split(/\r?\n/);
  const sliced = all.slice(Math.max(0, all.length - lines));
  return { path: p, lines: sliced, text: sliced.join('\n'), bytes: Buffer.byteLength(text) };
}

export function tailSyncLog(lines = 200) {
  return readTail(lines);
}

function isAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

function writeJob(state) {
  try {
    ensureHome();
    fs.writeFileSync(syncJobPath(), JSON.stringify(state, null, 2) + '\n', 'utf8');
  } catch {
    /* 状态文件写不进去不影响同步 */
  }
}

/** 上一次的 job 记录（宿主重启后从 sync-job.json 读回来，用于告诉界面「上次中断了」）。 */
let previousJob = null;

/** 给子进程输出逐行加时间戳，顺便当心跳用（收到数据就算「还活着」）。 */
function stampTransform(onData) {
  let rest = '';
  const t = new Transform({
    transform(chunk, _enc, cb) {
      onData();
      rest += chunk.toString('utf8');
      const lines = rest.split(/\r?\n/);
      rest = lines.pop();
      if (lines.length) this.push(lines.map((l) => (l ? stamp() + l : '')).join('\n') + '\n');
      cb();
    },
    flush(cb) {
      if (rest) this.push(stamp() + rest);
      rest = '';
      cb();
    },
  });
  return t;
}

/** 纯函数：判断是否卡住（便于单测）。 */
export function judgeStall({ now, startedMs, lastOutputMs: lastMs, idleMs, hardMs }) {
  if (hardMs > 0 && now - startedMs > hardMs) return { stalled: true, reason: 'total' };
  if (idleMs > 0 && now - lastMs > idleMs) return { stalled: true, reason: 'idle' };
  return { stalled: false, reason: '' };
}

function minutes(ms) {
  return Math.round(ms / 60000);
}

function loadPrevious() {
  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(syncJobPath(), 'utf8'));
  } catch {
    return;
  }
  if (!state) return;
  if (state.phase !== 'running') {
    previousJob = state;
    return;
  }
  if (isAlive(state.pid)) {
    orphan = state;
    previousJob = state;
    return;
  }
  previousJob = {
    ...state,
    phase: 'interrupted',
    finishedAt: new Date().toISOString(),
    result: '上次同步没有正常结束（宿主重启或崩溃），已标记为中断',
  };
  writeJob(previousJob);
}
loadPrevious();

function appendLog(text) {
  if (!logStream) return;
  try {
    logStream.write(stamp() + text + '\n');
  } catch {
    /* 日志写失败不阻塞 */
  }
}

export function syncState() {
  const cfg = readConfig();
  const idleMinutes = Number.isFinite(Number(cfg.syncIdleMinutes)) ? Number(cfg.syncIdleMinutes) : 10;
  const maxMinutes = Number.isFinite(Number(cfg.syncMaxMinutes)) ? Number(cfg.syncMaxMinutes) : 180;
  const runningSec = job && job.startedMs ? Math.max(0, Math.round((Date.now() - job.startedMs) / 1000)) : 0;
  const idleSec = lastOutputMs ? Math.max(0, Math.round((Date.now() - lastOutputMs) / 1000)) : 0;
  return {
    running: child !== null,
    job: job !== null ? { ...job } : previousJob === null ? null : { ...previousJob },
    pid: child === null ? null : child.pid,
    logPath: syncLogPath(),
    jobPath: syncJobPath(),
    last: readLast(),
    orphan: orphan === null ? null : { ...orphan },
    runningSec,
    idleSec,
    timeout: { idleMinutes, maxMinutes },
  };
}

function finishJob(exitCode, note) {
  if (!job) return;
  const text = readTail(400).text;
  const match = /SYNC RESULT:.*/i.exec(text);
  job.finishedAt = new Date().toISOString();
  job.exitCode = exitCode;
  job.phase = exitCode === 0 && !job.stalled ? 'done' : 'failed';
  job.result = job.stalled || note || (match ? match[0].trim() : 'exit=' + exitCode);
  writeJob({ ...job, logPath: syncLogPath() });
}

export function startSync(mode = 'upload') {
  if (mode !== 'upload' && mode !== 'download') return { ok: false, error: '未知同步模式: ' + mode };
  if (child !== null) return { ok: false, error: '已有同步任务在运行', job: { ...job } };
  if (orphan !== null) {
    return {
      ok: false,
      error: '上次的同步进程（pid ' + orphan.pid + '）还活着，可能已经卡住；先点「结束任务」再开始',
      orphan: { ...orphan },
    };
  }
  const cfg = readConfig();
  ensureHome();
  const p = syncLogPath();
  fs.writeFileSync(p, '', 'utf8');
  logStream = fs.createWriteStream(p, { flags: 'a' });
  const startedMs = Date.now();
  lastOutputMs = startedMs;
  job = {
    mode: 'sync-' + mode,
    startedAt: new Date().toISOString(),
    startedMs,
    finishedAt: null,
    exitCode: null,
    phase: 'spawn',
    result: null,
    pid: null,
    stalled: '',
    logPath: p,
  };
  let proc;
  try {
    proc = spawn(process.execPath, [SCRIPT(), '--mode', mode], {
      cwd: homeDir(),
      env: childEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    job.finishedAt = new Date().toISOString();
    job.phase = 'failed';
    job.result = String((error && error.message) || error);
    job = null;
    try {
      logStream.end();
    } catch {
      /* 已关闭 */
    }
    logStream = null;
    return { ok: false, error: String((error && error.message) || error) };
  }
  child = proc;
  job.pid = proc.pid;
  job.phase = 'running';
  writeJob({ ...job });
  const onData = () => {
    lastOutputMs = Date.now();
    if (job) job.lastOutputAt = new Date(lastOutputMs).toISOString();
  };
  const outT = stampTransform(onData);
  const errT = stampTransform(onData);
  proc.stdout.pipe(outT).pipe(logStream, { end: false });
  proc.stderr.pipe(errT).pipe(logStream, { end: false });

  const idleMs = Math.max(1, Number(cfg.syncIdleMinutes) || 10) * 60 * 1000;
  const hardMs = Math.max(0, Number(cfg.syncMaxMinutes) || 180) * 60 * 1000;
  const thisProc = proc;
  watchdog = setInterval(() => {
    if (!job || child !== thisProc) return;
    const verdict = judgeStall({ now: Date.now(), startedMs, lastOutputMs, idleMs, hardMs });
    if (!verdict.stalled) return;
    const reason =
      verdict.reason === 'idle'
        ? '同步卡住：连续 ' + minutes(idleMs) + ' 分钟没有任何输出（网络或云盘可能停了），已自动中止'
        : '同步超时：超过 ' + minutes(hardMs) + ' 分钟仍未结束，已自动中止';
    job.stalled = reason;
    job.phase = 'stopping';
    appendLog('[warn] ' + reason);
    try {
      thisProc.kill('SIGTERM');
    } catch {
      /* 进程可能已退出 */
    }
    killTimer = setTimeout(() => {
      try {
        thisProc.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }, KILL_GRACE_MS);
  }, 5000);

  thisProc.on('exit', (code) => {
    if (watchdog) clearInterval(watchdog);
    watchdog = null;
    if (killTimer) clearTimeout(killTimer);
    killTimer = null;
    finishJob(code, null);
    child = null;
    try {
      outT.end();
      errT.end();
      logStream.end();
    } catch {
      /* 已关闭 */
    }
    logStream = null;
    lastOutputMs = 0;
  });
  thisProc.on('error', (error) => {
    finishJob(null, String((error && error.message) || error));
    job.phase = 'failed';
    child = null;
  });
  return { ok: true, pid: thisProc.pid, job: { ...job } };
}

export function cancelSync() {
  if (child !== null) {
    const pid = child.pid;
    job.stalled = '已被手动中止';
    job.phase = 'stopping';
    appendLog('[warn] 用户点了「结束任务」，正在中止（pid ' + pid + '）');
    try {
      child.kill('SIGTERM');
    } catch {
      /* 进程可能已退出 */
    }
    const thisChild = child;
    setTimeout(() => {
      try {
        if (child === thisChild) thisChild.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }, KILL_GRACE_MS);
    return { ok: true, pid, killed: true };
  }
  if (orphan !== null) {
    const pid = orphan.pid;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* 已退出 */
    }
    setTimeout(() => {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* 已退出 */
      }
    }, KILL_GRACE_MS);
    writeJob({ ...orphan, phase: 'cancelled', finishedAt: new Date().toISOString(), result: '上次遗留的同步进程已被手动结束' });
    orphan = null;
    return { ok: true, pid, killed: true, orphan: true };
  }
  return { ok: false, error: '没有正在运行的同步任务' };
}