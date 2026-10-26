import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

// 用一个只有几个文件的假 DSH 目录跑通：spawn → 打包 → 加密 → 校验 → 读日志
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ab-e2e-'));
const fakeDsh = path.join(tmp, 'dsh-home');
const staging = path.join(tmp, 'staging');
fs.mkdirSync(path.join(fakeDsh, 'storages'), { recursive: true });
fs.mkdirSync(path.join(fakeDsh, 'sessions', 'demo'), { recursive: true });
fs.writeFileSync(path.join(fakeDsh, 'storages', 'workspace.json'), JSON.stringify({ tables: { workspaces: {} } }));
fs.writeFileSync(path.join(fakeDsh, 'sessions', 'demo', 'a.jsonl'), '{"event":"hello"}\n'.repeat(20));
fs.writeFileSync(path.join(fakeDsh, 'dsh-settings.json'), '{"theme":"dark"}');

const home = path.join(tmp, 'plugin-home');
fs.mkdirSync(home, { recursive: true });
process.env.DSH_AB_HOME = home;
fs.writeFileSync(
  path.join(home, 'config.json'),
  JSON.stringify({ dshHome: fakeDsh, stagingDir: staging, remoteDir: '/DeepSeek Harness/DSH-Backup', keep: 0, includeFeishuFiles: false }, null, 2),
);

const routes = new Map();
const ctx = {
  effect(fn) {
    fn();
    return () => {};
  },
  webServer: {
    register(route) {
      routes.set(route.path, route.handler);
      return () => {};
    },
  },
};
const host = await import(new URL('../lib/index.js', import.meta.url).href);
host.apply(ctx);

function call(routePath, { method = 'GET', body, url } = {}) {
  const handler = routes.get(routePath);
  const listeners = new Map();
  const req = {
    method,
    url: url || routePath,
    socket: { remoteAddress: '127.0.0.1' },
    on(event, cb) {
      listeners.set(event, cb);
      return req;
    },
    destroy() {},
  };
  const res = { statusCode: 0, headers: {}, body: '' };
  const done = new Promise((resolve) => {
    res.writeHead = (status, headers) => {
      res.statusCode = status;
      res.headers = headers || {};
    };
    res.end = (text) => {
      res.body = text || '';
      resolve(res);
    };
  });
  handler(req, res);
  if (body !== undefined) {
    listeners.get('data')?.(Buffer.from(JSON.stringify(body), 'utf8'));
    listeners.get('end')?.();
  } else {
    listeners.get('end')?.();
  }
  return done.then((r) => ({ status: r.statusCode, json: JSON.parse(r.body || '{}') }));
}

const base = '/api/dsh-aliyunpan-backup';
const started = await call(base + '/run', { method: 'POST', body: { mode: 'verify' } });
assert.equal(started.status, 200, 'run accepted: ' + JSON.stringify(started.json));
assert.equal(started.json.ok, true);
assert.equal(started.json.job.mode, 'verify');

const deadline = Date.now() + 180000;
let state;
for (;;) {
  const res = await call(base + '/status');
  state = res.json.state;
  if (!state.running) break;
  if (Date.now() > deadline) throw new Error('timeout waiting for job');
  await new Promise((r) => setTimeout(r, 400));
}
const log = (await call(base + '/log', { url: base + '/log?lines=200' })).json;
const text = log.text;
assert.equal(state.job.phase, 'done', 'job done: ' + state.job.phase + ' / ' + text.slice(-600));
assert.equal(state.job.exitCode, 0, 'exit 0');
assert.match(text, /\[1\/5\] scanned fileCount=3/, 'build scanned the 3 fake files');
assert.match(text, /verify: ok=3 bad=0 missing=0/, 'restore verified 3 files');
assert.match(state.job.result || '', /RESULT: snapshot=\d{8}T\d{4}-full/, 'result line: ' + state.job.result);

const snaps = fs.readdirSync(path.join(staging, 'snapshots')).filter((d) => /^\d{8}T\d{4}-full$/.test(d));
assert.equal(snaps.length, 1, 'one snapshot written');
const enc = fs.statSync(path.join(staging, 'snapshots', snaps[0], 'payload.enc')).size;
assert.ok(enc > 200, 'payload.enc bytes=' + enc);
assert.ok(fs.existsSync(path.join(staging, 'KEY.txt')), 'KEY.txt generated');

// 恢复（仅校验）也要能跑
const restore = await call(base + '/restore', { method: 'POST', body: { snapshot: snaps[0], verifyOnly: true } });
assert.equal(restore.status, 200, 'restore accepted: ' + JSON.stringify(restore.json));
for (;;) {
  const res = await call(base + '/status');
  state = res.json.state;
  if (!state.running) break;
  if (Date.now() > deadline) throw new Error('timeout waiting for restore');
  await new Promise((r) => setTimeout(r, 300));
}
assert.equal(state.job.phase, 'done', 'restore done');
assert.match(state.job.result || '', /ok=3 bad=0 missing=0/, 'restore result: ' + state.job.result);

console.log('E2E OK  enc=' + enc + 'B  snapshot=' + snaps[0] + '  home=' + home);
