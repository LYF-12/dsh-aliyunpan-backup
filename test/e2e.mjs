import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { writePackage } from './fixtures/make-package.mjs';

// 解码链路 e2e：造一个与旧版备份包同格式的 payload.enc，走 HTTP 路由校验 + 解包
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ab-e2e-'));
const staging = path.join(tmp, 'staging');
const pluginHome = path.join(tmp, 'plugin-home');
fs.mkdirSync(pluginHome, { recursive: true });
process.env.DSH_AB_HOME = pluginHome;
fs.writeFileSync(
  path.join(pluginHome, 'config.json'),
  JSON.stringify({ stagingDir: staging }, null, 2),
);

// 包放在任意目录（模拟「从云端下载/别人分享」的位置），不放进暂存目录
const pkgDir = path.join(tmp, 'downloaded', '20261026T1917-full');
const PASS = 'e2e-passphrase-123';
const payloads = [
  { path: 'storages\\workspace.json', data: JSON.stringify({ tables: { workspaces: {} } }) },
  { path: 'sessions\\demo\\a.jsonl.zstd', data: '{"event":"hello"}\n'.repeat(20) },
  { path: 'profiles\\desktop\\cordis.patch.yml', data: 'patch:\n  - insert:\n      - id: demo\n' },
];
const built = writePackage({ files: payloads, passphrase: PASS, outDir: pkgDir, createdAt: '2026-10-26T19:17:00.000Z' });
assert.ok(built.enc > 100, 'payload.enc bytes=' + built.enc);
assert.equal(built.manifest.fileCount, 3, 'manifest files');

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
const deadline = Date.now() + 120000;

async function waitIdle() {
  for (;;) {
    const res = await call(base + '/status');
    if (!res.json.state.running) return res.json.state;
    if (Date.now() > deadline) throw new Error('timeout waiting for job');
    await new Promise((r) => setTimeout(r, 300));
  }
}

// 1) inspect：页面输入框边输边提示
const insp = await call(base + '/inspect', { url: base + '/inspect?pkg=' + encodeURIComponent(path.join(pkgDir, 'payload.enc')) });
assert.equal(insp.status, 200, 'inspect status');
assert.equal(insp.json.found, true, 'inspect found the package by payload.enc path');
assert.equal(insp.json.info.fileCount, 3, 'inspect reads package.info.json');

// 2) 校验（口令由页面传入，不用本机口令文件）
const verify = await call(base + '/restore', { method: 'POST', body: { pkg: pkgDir, passphrase: PASS, verifyOnly: true } });
assert.equal(verify.status, 200, 'verify accepted: ' + JSON.stringify(verify.json));
let state = await waitIdle();
assert.equal(state.job.phase, 'done', 'verify done: ' + state.job.result);
assert.match(state.job.result || '', /ok=3 bad=0 missing=0/, 'verify result: ' + state.job.result);

// 3) 错误口令：必须失败且给出 AUTH FAIL
const wrong = await call(base + '/restore', { method: 'POST', body: { pkg: pkgDir, passphrase: 'wrong-passphrase', verifyOnly: true } });
assert.equal(wrong.status, 200, 'wrong pass accepted for spawn');
state = await waitIdle();
assert.equal(state.job.phase, 'failed', 'wrong pass -> failed');
const log = (await call(base + '/log', { url: base + '/log?lines=200' })).json;
assert.match(log.text, /AUTH FAIL at chunk 0/, 'log shows AUTH FAIL');

// 4) 解包到指定目录
const outDir = path.join(tmp, 'out');
const extract = await call(base + '/restore', { method: 'POST', body: { pkg: pkgDir, passphrase: PASS, verifyOnly: false, out: outDir } });
assert.equal(extract.status, 200, 'extract accepted: ' + JSON.stringify(extract.json));
assert.equal(extract.json.outDir, outDir, 'outDir echoed');
state = await waitIdle();
assert.equal(state.job.phase, 'done', 'extract done: ' + state.job.result);
assert.match(state.job.result || '', /extracted=3/, 'extract result: ' + state.job.result);

for (const p of payloads) {
  const dest = path.join(outDir, ...p.path.split(/[\\/]+/).filter(Boolean));
  assert.ok(fs.existsSync(dest), 'extracted file exists: ' + dest);
  const want = Buffer.isBuffer(p.data) ? p.data : Buffer.from(String(p.data), 'utf8');
  assert.equal(fs.readFileSync(dest).toString('utf8'), want.toString('utf8'), 'content matches: ' + p.path);
}
assert.ok(fs.existsSync(path.join(outDir, 'RESTORE-manifest.json')), 'manifest written');
assert.ok(!fs.existsSync(path.join(pkgDir, '.restore-tmp.bundle')), 'temp bundle cleaned up');

// 5) 包名相对路径（暂存目录 snapshots 下）也能解：复制进去再按名字解
const snapDir = path.join(staging, 'snapshots', '20261026T1917-full');
fs.mkdirSync(path.dirname(snapDir), { recursive: true });
fs.cpSync(pkgDir, snapDir, { recursive: true });
const byName = await call(base + '/restore', { method: 'POST', body: { pkg: '20261026T1917-full', passphrase: PASS, verifyOnly: true } });
assert.equal(byName.status, 200, 'relative package name accepted');
state = await waitIdle();
assert.equal(state.job.phase, 'done', 'relative verify done');
const status = await call(base + '/status');
assert.equal(status.json.packages.length, 1, 'status lists the package');
assert.equal(status.json.packages[0].id, '20261026T1917-full', 'package id');

console.log('E2E OK  enc=' + built.enc + 'B  out=' + outDir);
