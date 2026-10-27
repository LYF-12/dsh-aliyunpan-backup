import { spawn, spawnSync } from 'node:child_process';
import { readConfig, resolveExe } from './config.mjs';

// 阿里云盘登录：aliyunpan login 是交互式命令（打印授权链接 → 浏览器授权 + APP 扫码 → 回车）。
// 这里把它做成「后台子进程 + 页面显示链接 + 一键回车」，让新机器不用开终端也能登录。
const MAX_LOG = 200;
const HARD_MS = 6 * 60 * 1000;
const URL_RE = /https:\/\/openapi\.alipan\.com\/oauth\/authorize\S+/;
const DONE_RE = /登录成功|登录完成|login success/i;

let child = null;
let timer = null;
let buffer = '';
let cachedAccount = { at: 0, value: null };

const state = {
  running: false,
  phase: 'idle', // idle | starting | waiting | done | failed | cancelled
  url: '',
  log: [],
  startedAt: 0,
  exitCode: null,
  error: '',
};

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function push(text) {
  const line = String(text || '')
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\r/g, '')
    .trim();
  if (!line) return;
  state.log.push(stamp() + ' ' + line);
  if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
}

function reset() {
  buffer = '';
  state.url = '';
  state.log = [];
  state.startedAt = Date.now();
  state.exitCode = null;
  state.error = '';
}

function finish(reason) {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  child = null;
  state.running = false;
  if (reason) state.error = reason;
}

function onData(chunk) {
  buffer += String(chunk);
  let index = buffer.search(/\r?\n/);
  while (index >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + (buffer[index] === '\r' ? 2 : 1));
    push(line);
    const match = line.match(URL_RE);
    if (match && match[0] !== state.url) {
      state.url = match[0];
      state.phase = 'waiting';
      push('[i] 已拿到授权链接，在浏览器里打开它完成授权 + 扫码，然后点「我已扫码，继续」。');
    }
    if (DONE_RE.test(line)) state.phase = 'done';
    index = buffer.search(/\r?\n/);
  }
  if (buffer.length > 4000) buffer = buffer.slice(-2000);
}

/** 当前登录账号（aliyunpan who），30 秒缓存，避免状态轮询频繁起进程。 */
export function accountInfo(options) {
  const maxAgeMs = (options && options.maxAgeMs) || 30000;
  if (cachedAccount.value && Date.now() - cachedAccount.at < maxAgeMs) return cachedAccount.value;
  let value = { ok: false, uid: '', nick: '', drive: '', reason: '找不到 aliyunpan', at: Date.now() };
  const exe = resolveExe(readConfig());
  if (exe) {
    const result = spawnSync(exe, ['who'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    const out = (result.stdout || '') + (result.stderr || '');
    const uid = (out.match(/UID[:：]\s*([0-9a-zA-Z]+)/) || [])[1] || '';
    const nick = (out.match(/昵称[:：]\s*([^,，\s]+)/) || [])[1] || '';
    const drive = (out.match(/当前使用网盘[:：]\s*([^\s,，]+)/) || [])[1] || '';
    const ok = result.status === 0 && !/未登录|未登陆|not logged|FATAL ERROR|panic:/i.test(out);
    const firstLine = out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || '';
    value = { ok, uid, nick, drive, exe, at: Date.now(), reason: ok ? '' : firstLine || 'aliyunpan 退出码 ' + result.status };
  }
  cachedAccount = { at: Date.now(), value };
  return value;
}

export function loginSummary() {
  const account = accountInfo();
  return {
    running: state.running,
    phase: state.phase,
    url: state.url,
    startedAt: state.startedAt,
    exitCode: state.exitCode,
    error: state.error,
    account: { ok: account.ok, nick: account.nick, uid: account.uid, drive: account.drive, reason: account.reason, exe: account.exe || '' },
    log: state.log.slice(-120),
  };
}

export function startLogin() {
  if (state.running) return { ok: false, error: '正在登录中，请先在页面上完成当前登录' };
  const exe = resolveExe(readConfig());
  if (!exe) return { ok: false, error: '找不到 aliyunpan 可执行文件：先在「运行环境」里下载安装' };
  reset();
  state.phase = 'starting';
  state.running = true;
  push('开始登录：' + exe);
  try {
    child = spawn(exe, ['login'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch (error) {
    state.phase = 'failed';
    finish('无法启动 aliyunpan：' + String((error && error.message) || error));
    return { ok: false, error: state.error };
  }
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (error) => {
    state.phase = 'failed';
    push('启动失败：' + String((error && error.message) || error));
    finish(String((error && error.message) || error));
  });
  child.on('exit', (code) => {
    state.exitCode = code;
    const cancelled = state.phase === 'cancelled';
    const said = DONE_RE.test(state.log.join('\n'));
    let done = said;
    if (!done && !cancelled) {
      cachedAccount = { at: 0, value: null };
      done = accountInfo({ maxAgeMs: 0 }).ok;
    }
    state.phase = cancelled ? 'cancelled' : done ? 'done' : 'failed';
    if (done) {
      cachedAccount = { at: 0, value: null };
      push('登录完成，账号信息已刷新');
    } else if (!cancelled && !state.error) {
      state.error = '登录没有完成（链接 5 分钟内有效，授权 + 扫码后要点「我已扫码，继续」）';
    }
    finish('');
  });
  timer = setTimeout(() => {
    push('[!] 6 分钟没有完成登录，已结束本次登录，可重新开始');
    state.phase = 'failed';
    state.error = '登录超时（链接有效期 5 分钟）';
    try {
      if (child) child.kill();
    } catch {
      /* 已经退出了 */
    }
    finish('');
  }, HARD_MS);
  if (timer.unref) timer.unref();
  return { ok: true };
}

/** 往 aliyunpan login 的 stdin 敲一个回车（浏览器里授权 + 扫码之后）。 */
export function confirmLogin() {
  if (!child || !state.running) return { ok: false, error: '当前没有进行中的登录' };
  if (!state.url) return { ok: false, error: '还没拿到授权链接，等页面里出现链接再操作' };
  try {
    child.stdin.write('\n');
  } catch (error) {
    return { ok: false, error: '发送回车失败：' + String((error && error.message) || error) };
  }
  push('[i] 已发送回车，等待 aliyunpan 完成登录');
  return { ok: true };
}

export function cancelLogin() {
  if (!child || !state.running) return { ok: false, error: '当前没有进行中的登录' };
  state.phase = 'cancelled';
  push('[i] 已取消登录');
  try {
    child.kill();
  } catch {
    /* 已经退出 */
  }
  finish('');
  return { ok: true };
}
