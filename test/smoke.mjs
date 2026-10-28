import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ab-'));
process.env.DSH_AB_HOME = tmpHome;
process.env.DSH_AB_NO_UPDATE_CHECK = '1'; // 自更新检查会打网络，测试里关掉

const routes = new Map();
const effectLabels = [];
const ctx = {
  effect(fn, label) {
    effectLabels.push(label);
    const dispose = fn();
    return () => {
      if (typeof dispose === 'function') dispose();
    };
  },
  webServer: {
    register(route) {
      assert.equal(route.kind, 'exact', 'route kind');
      assert.ok(route.path.startsWith('/api/dsh-aliyunpan-backup'), 'route prefix: ' + route.path);
      assert.equal(typeof route.handler, 'function', 'handler fn');
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    },
  },
};

const host = await import(new URL('../lib/index.js', import.meta.url).href);
assert.equal(host.name, 'dsh-aliyunpan-backup', 'host name');
assert.deepEqual(host.inject, ['webServer'], 'host inject');
host.apply(ctx);
assert.ok(routes.size >= 5, 'routes registered: ' + [...routes.keys()].join(','));
assert.ok(effectLabels.some((l) => /dsh-aliyunpan-backup/.test(l)), 'effect label');

function call(routePath, { method = 'GET', body, url } = {}) {
  const handler = routes.get(routePath);
  assert.ok(handler, 'missing route ' + routePath);
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
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers || {};
    },
    end(text) {
      this.body = text || '';
    },
  };
  const done = new Promise((resolve) => {
    res.end = (text) => {
      res.body = text || '';
      resolve(res);
    };
  });
  handler(req, res);
  if (body !== undefined) {
    const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    listeners.get('data')?.(buf);
    listeners.get('end')?.();
  } else {
    listeners.get('end')?.();
  }
  return done.then((r) => ({ status: r.statusCode, headers: r.headers, text: r.body, json: safeJson(r.body) }));
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const base = '/api/dsh-aliyunpan-backup';

// 备份（打包上传）链路整个下掉了：路由表里不该再有 /run、/cancel
assert.equal(routes.has(base + '/run'), false, 'no /run route (backup pipeline removed)');
assert.equal(routes.has(base + '/cancel'), false, 'no /cancel route');
assert.ok(routes.has(base + '/restore'), 'decode route present');
assert.ok(routes.has(base + '/inspect'), 'inspect route present');

const config = await call(base + '/config');
assert.equal(config.status, 200, 'GET /config status');
assert.equal(config.json.ok, true);
assert.ok(config.json.view.stagingDir, 'staging dir resolved');
assert.equal(typeof config.json.view.restoreDir, 'string', 'restore dir exposed');
assert.equal(config.json.config.keep, undefined, 'backup-only keep field is gone');

const saved = await call(base + '/config', { method: 'POST', body: { stagingDir: tmpHome, dshHome: tmpHome, bogus: 1 } });
assert.equal(saved.status, 200, 'POST /config status');
assert.equal(saved.json.config.stagingDir, tmpHome, 'staging saved');
assert.equal(saved.json.config.bogus, undefined, 'unknown key rejected');
assert.ok(fs.existsSync(path.join(tmpHome, 'config.json')), 'config file written');

const badSave = await call(base + '/config', { method: 'POST', body: { bogus: 1 } });
assert.equal(badSave.status, 400, 'no valid fields -> 400');

const status = await call(base + '/status');
assert.equal(status.status, 200);
assert.equal(status.json.state.running, false, 'idle');
assert.ok(Array.isArray(status.json.packages), 'packages array');
assert.equal(typeof status.json.log.text, 'string', 'log text');

const insp = await call(base + '/inspect', { url: base + '/inspect?pkg=' + encodeURIComponent(path.join(tmpHome, 'nope')) });
assert.equal(insp.status, 200, 'inspect status');
assert.equal(insp.json.found, false, 'inspect reports missing payload.enc');

const ui = await call(base + '/ui');
assert.equal(ui.status, 200);
assert.match(ui.headers['content-type'], /text\/html/);
assert.match(ui.text, /阿里云盘同步/);
assert.match(ui.text, /\/api\/dsh-aliyunpan-backup/);
assert.match(ui.text, /同步（多机共享/, 'ui has the sync card');
assert.match(ui.text, /开始同步/, 'ui has the sync run button');
assert.match(ui.text, /解码本地包/, 'ui has the decode card');
assert.match(ui.text, /payload\.enc/, 'ui explains the package format');
assert.doesNotMatch(ui.text, /立即备份并上传/, 'backup button removed');

const log = await call(base + '/log', { url: base + '/log?lines=5' });
assert.equal(log.status, 200);
assert.ok(Array.isArray(log.json.lines), 'log lines array');

// ---- 同步 ----
const syncStatus = await call(base + '/sync');
assert.equal(syncStatus.status, 200, 'GET /sync status');
assert.equal(syncStatus.json.ok, true);
assert.equal(syncStatus.json.mode, 'upload', 'default sync mode');
assert.ok(syncStatus.json.dir.startsWith('/'), 'sync cloud dir');
assert.equal(syncStatus.json.dirs.filter((d) => d.kind === 'dir').length, 4, 'default sync dirs');
assert.ok(syncStatus.json.dirs.some((d) => d.kind === 'file'), 'assembly files are part of the default roots');
assert.equal(syncStatus.json.choices.includes('sessions'), true, 'choices include sessions');
assert.equal(syncStatus.json.state.running, false, 'sync idle');
assert.equal(typeof syncStatus.json.log.text, 'string', 'sync log text');

const syncSaved = await call(base + '/config', { method: 'POST', body: {
  syncMode: 'download',
  syncDir: '/DeepSeek Harness/DSH-Sync',
  syncMachine: 'test-machine',
  syncLockMinutes: 30,
  syncDirs: ['sessions', 'pets', 'node_modules', '../etc'],
} });
assert.equal(syncSaved.status, 200, 'POST /config sync fields');
assert.equal(syncSaved.json.config.syncMode, 'download', 'sync mode saved');
assert.deepEqual(syncSaved.json.config.syncDirs, ['sessions', 'pets'], 'whitelist filters unknown dirs');
assert.equal(syncSaved.json.config.syncLockMinutes, 30, 'lock minutes saved');
assert.deepEqual(syncSaved.json.view.syncRoots.filter((r) => r.kind === 'dir').map((r) => r.name), ['sessions', 'pets'], 'syncRoots follows selection');

const plan = await call(base + '/sync/plan');
assert.equal(plan.status, 200, 'GET /sync/plan');
assert.equal(plan.json.plan.roots.filter((r) => r.kind === 'dir').length, 2, 'plan dir roots');
assert.equal(plan.json.plan.totalFiles, 0, 'empty fake dsh home -> 0 files');
assert.match(plan.json.plan.roots[0].remote, /DSH-Sync\/sessions$/);

// ---- 配置文件级同步（模型装配 / 插件清单 / 凭据）----
const fileInfo = await call(base + '/sync');
assert.equal(fileInfo.json.fileChoices.length, 3, 'file choices exposed');
const fileIds = fileInfo.json.fileChoices.map((c) => c.id);
assert.deepEqual(fileIds, ['model', 'plugins', 'credentials'], 'file choice ids');

// 造假 profile 目录：装配文件要能被选进同步根，_bak-* 目录要跳过
fs.mkdirSync(path.join(tmpHome, 'profiles', 'desktop'), { recursive: true });
fs.mkdirSync(path.join(tmpHome, 'profiles', '_bak-old'), { recursive: true });
fs.writeFileSync(path.join(tmpHome, 'profiles', 'desktop', 'cordis.patch.yml'), 'llm: {}\n');
fs.writeFileSync(path.join(tmpHome, 'profiles', 'desktop', 'package.json'), '{"name":"p"}\n');
fs.writeFileSync(path.join(tmpHome, '.credentials.yaml'), 'refs: []\n');

const fileCfg = await call(base + '/config', { method: 'POST', body: { syncFiles: ['model', 'plugins', 'credentials', 'nope'] } });
assert.deepEqual(fileCfg.json.config.syncFiles, ['model', 'plugins', 'credentials'], 'syncFiles goes through the whitelist');
const fileRoots = fileCfg.json.view.syncRoots.filter((r) => r.kind === 'file').map((r) => r.name).sort();
assert.deepEqual(
  fileRoots,
  ['.credentials.yaml', 'profiles/desktop/cordis.patch.yml', 'profiles/desktop/package.json', 'profiles/desktop/pnpm-lock.yaml', 'profiles/desktop/pnpm-workspace.yaml'],
  'file roots: ' + fileRoots.join(','),
);
assert.equal(fileRoots.some((n) => n.includes('_bak-old')), false, 'backup profile directories are skipped');

const planWithFiles = await call(base + '/sync/plan');
const planned = planWithFiles.json.plan.roots.filter((r) => r.kind === 'file');
assert.equal(planned.find((r) => r.name === '.credentials.yaml').exists, true, 'existing credential file detected');
assert.equal(planned.find((r) => r.name === '.credentials.yaml').files, 1, 'file root counts as one file');
assert.equal(planned.find((r) => r.name.endsWith('pnpm-lock.yaml')).exists, false, 'missing file reported as absent');

const pickGet = await call(base + '/pick');
assert.equal(pickGet.status, 405, '/pick only accepts POST');

const badSync = await call(base + '/sync/run', { method: 'POST', body: { mode: 'nope' } });
assert.equal(badSync.status, 400, 'bad sync mode rejected');
const nothingToCancel = await call(base + '/sync/cancel', { method: 'POST' });
assert.equal(nothingToCancel.json.ok, false, 'cancel without running sync');

// ---- 自举安装（aliyunpan）----
assert.ok(routes.has(base + '/provision'), 'provision status route');
assert.ok(routes.has(base + '/provision/run'), 'provision run route');

const provStatus = await call(base + '/provision');
assert.equal(provStatus.status, 200, 'GET /provision status');
assert.equal(typeof provStatus.json.installed, 'boolean', 'installed flag');
assert.equal(typeof provStatus.json.supported, 'boolean', 'supported flag');
assert.ok(provStatus.json.target.split(/[\\/]/).includes('tools'), 'install target lives under tools/: ' + provStatus.json.target);
assert.equal(provStatus.json.running, false, 'provision idle');
assert.ok(Array.isArray(provStatus.json.log), 'provision log array');

const statusWithEnv = await call(base + '/status');
assert.equal(typeof statusWithEnv.json.env.installed, 'boolean', '/status exposes env.installed');
assert.equal(statusWithEnv.json.provision.running, false, '/status exposes provision summary');

const badScheme = await call(base + '/provision/run', { method: 'POST', body: { url: 'ftp://example.test/x.zip' } });
assert.equal(badScheme.status, 409, 'non-http url rejected');
assert.match(badScheme.json.error, /http\(s\)/);

// 连不上的地址：应当很快进入 failed，而不是把进程挂住
const failing = await call(base + '/provision/run', { method: 'POST', body: { url: 'http://127.0.0.1:1/aliyunpan.zip' } });
assert.equal(failing.status, 200, 'failing download still starts a job');
let provSettled = null;
for (let i = 0; i < 40; i++) {
  const state = await call(base + '/provision');
  if (!state.json.running) {
    provSettled = state.json;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
assert.ok(provSettled, 'provision job settles');
assert.equal(provSettled.phase, 'failed', 'unreachable url -> failed phase');
assert.ok(String(provSettled.error || '').length > 0, 'failure carries a message');

// 资产匹配矩阵：三个平台 × 两种架构都要挑对包
const { pickAsset } = await import(new URL('../lib/provision.mjs', import.meta.url).href);
// 真实 v0.4.0 资产名（全部是 .zip，darwin 叫 darwin-macos-*，另有 android/ios/freebsd 干扰项）
const assetNames = [
  'aliyunpan-v0.4.0-android-api21-arm64.zip',
  'aliyunpan-v0.4.0-darwin-macos-amd64.zip',
  'aliyunpan-v0.4.0-darwin-macos-arm64.zip',
  'aliyunpan-v0.4.0-freebsd-amd64.zip',
  'aliyunpan-v0.4.0-ios-arm64.zip',
  'aliyunpan-v0.4.0-linux-386.zip',
  'aliyunpan-v0.4.0-linux-amd64.zip',
  'aliyunpan-v0.4.0-linux-arm64.zip',
  'aliyunpan-v0.4.0-linux-armv7.zip',
  'aliyunpan-v0.4.0-linux-loong64.zip',
  'aliyunpan-v0.4.0-windows-arm64.zip',
  'aliyunpan-v0.4.0-windows-x64.zip',
  'aliyunpan-v0.4.0-windows-x86.zip',
  'checksums.txt',
];
const assetList = assetNames.map((name) => ({ name, browser_download_url: 'https://example.test/' + name, size: 1 }));
const expect = {
  'win32/x64': 'aliyunpan-v0.4.0-windows-x64.zip',
  'win32/arm64': 'aliyunpan-v0.4.0-windows-arm64.zip',
  'win32/ia32': 'aliyunpan-v0.4.0-windows-x86.zip',
  'linux/x64': 'aliyunpan-v0.4.0-linux-amd64.zip',
  'linux/arm64': 'aliyunpan-v0.4.0-linux-arm64.zip',
  'linux/arm': 'aliyunpan-v0.4.0-linux-armv7.zip',
  'linux/ia32': 'aliyunpan-v0.4.0-linux-386.zip',
  'darwin/x64': 'aliyunpan-v0.4.0-darwin-macos-amd64.zip',
  'darwin/arm64': 'aliyunpan-v0.4.0-darwin-macos-arm64.zip',
  'freebsd/x64': 'aliyunpan-v0.4.0-freebsd-amd64.zip',
};
for (const [key, wanted] of Object.entries(expect)) {
  const [platform, arch] = key.split('/');
  const picked = pickAsset(assetList, platform, arch);
  assert.equal(picked && picked.name, wanted, 'pickAsset ' + key);
}
assert.equal(pickAsset(assetList, 'aix', 'ppc'), null, 'unsupported platform -> null');
assert.equal(pickAsset([], 'win32', 'x64'), null, 'empty asset list -> null');

// ---- 插件自更新 ----
assert.ok(routes.has(base + '/update'), 'update status route');
assert.ok(routes.has(base + '/update/run'), 'update run route');
const updGet = await call(base + '/update');
assert.equal(updGet.status, 200, 'GET /update');
assert.equal(typeof updGet.json.current, 'string', 'current version exposed');
assert.match(updGet.json.current, /^[0-9]+[.][0-9]+[.][0-9]+/, 'current version looks like semver: ' + updGet.json.current);
assert.equal(updGet.json.running, false, 'update idle');
assert.ok(Array.isArray(updGet.json.installs), 'installs array');
assert.ok(Array.isArray(updGet.json.log), 'update log array');
const updStatus = await call(base + '/status');
assert.equal(typeof updStatus.json.update.current, 'string', '/status exposes update summary');
const updBad = await call(base + '/update/run', { method: 'GET' });
assert.equal(updBad.status, 405, '/update/run only accepts POST');

// ---- 阿里云盘登录 ----
for (const path of ['/login', '/login/start', '/login/confirm', '/login/cancel']) {
	assert.ok(routes.has(base + path), 'login route ' + path);
}
const loginGet = await call(base + '/login');
assert.equal(loginGet.status, 200, 'GET /login');
assert.equal(typeof loginGet.json.running, 'boolean', 'login running flag');
assert.equal(typeof loginGet.json.account, 'object', 'login account object');
assert.equal(typeof loginGet.json.account.ok, 'boolean', 'account ok flag');
assert.ok(Array.isArray(loginGet.json.log), 'login log array');
// 机器上可能真的装了/登录了 aliyunpan（resolveExe 会扫 PATH），所以只校验形状
if (loginGet.json.account.ok) assert.ok(String(loginGet.json.account.nick || '').length > 0, 'logged-in account carries a nick');
else assert.ok(String(loginGet.json.account.reason || '').length > 0, 'account reason explains why');
const loginStatus = await call(base + '/status');
assert.equal(typeof loginStatus.json.login.account.ok, 'boolean', '/status exposes login summary');
assert.equal((await call(base + '/login/confirm', { method: 'GET' })).status, 405, '/login/confirm only accepts POST');
const noSession = await call(base + '/login/confirm', { method: 'POST', body: {} });
assert.equal(noSession.status, 409, 'confirm without a running login -> 409');
assert.equal((await call(base + '/login/cancel', { method: 'POST', body: {} })).status, 409, 'cancel without a running login -> 409');
assert.equal(routes.size, 21, 'exactly 21 routes');

// ---- 0.6.0：同步日志 / 看门狗 / 跨重启任务态 ----
assert.ok(routes.has(base + '/sync/log'), 'sync log route exists');
const syncLogGet = await call(base + '/sync/log');
assert.equal(syncLogGet.status, 200, 'GET /sync/log');
for (const key of ['ok', 'path', 'lines', 'text', 'bytes', 'state']) {
	assert.ok(Object.prototype.hasOwnProperty.call(syncLogGet.json, key), 'sync log field ' + key);
}
assert.equal(typeof syncLogGet.json.text, 'string', 'log text is a string');
assert.equal(typeof syncLogGet.json.state.running, 'boolean', 'log carries sync state');
assert.equal((await call(base + '/sync/log', { method: 'POST' })).status, 405, '/sync/log only accepts GET');
assert.ok((await call(base + '/sync/log', { url: base + '/sync/log?lines=99999' })).json.lines <= 2000, 'lines clamped to 2000');
assert.equal(typeof (await call(base + '/sync/log', { url: base + '/sync/log?lines=1' })).json.lines, 'number', 'lines is a number');

const syncGet = await call(base + '/sync');
assert.equal(syncGet.status, 200, 'GET /sync');
assert.equal(typeof syncGet.json.timeout.idleMinutes, 'number', '/sync exposes idle timeout');
assert.equal(typeof syncGet.json.timeout.maxMinutes, 'number', '/sync exposes max timeout');
assert.ok(String(syncGet.json.state.jobPath || '').endsWith('sync-job.json'), '/sync exposes jobPath');
assert.ok(Array.isArray(syncGet.json.log.lines), '/sync still carries a log tail');

const sr = await import(new URL('../lib/syncrun.mjs', import.meta.url).href);
assert.equal(typeof sr.judgeStall, 'function', 'judgeStall exported');
assert.deepEqual(
	sr.judgeStall({ now: 1000 * 1000, startedMs: 0, lastOutputMs: 1000 * 1000 - 700 * 1000, idleMs: 600 * 1000, hardMs: 3600 * 1000 }),
	{ stalled: true, reason: 'idle' },
	'no output for 700s with a 600s idle limit -> idle stall',
);
assert.deepEqual(
	sr.judgeStall({ now: 1000 * 1000, startedMs: 0, lastOutputMs: 1000 * 1000 - 10 * 1000, idleMs: 600 * 1000, hardMs: 3600 * 1000 }),
	{ stalled: false, reason: '' },
	'fresh output keeps a job alive',
);
assert.deepEqual(
	sr.judgeStall({ now: 4000 * 1000, startedMs: 0, lastOutputMs: 4000 * 1000 - 5 * 1000, idleMs: 600 * 1000, hardMs: 3600 * 1000 }),
	{ stalled: true, reason: 'total' },
	'running past the hard limit -> total stall even with fresh output',
);
assert.deepEqual(
	sr.judgeStall({ now: 4000 * 1000, startedMs: 0, lastOutputMs: 4000 * 1000 - 5 * 1000, idleMs: 0, hardMs: 0 }),
	{ stalled: false, reason: '' },
	'0 disables both limits',
);

// 宿主重启后残留的 running 任务：pid 已死 -> 标记 interrupted，绝不再报「同步中」
fs.writeFileSync(sr.syncJobPath(), JSON.stringify({
	phase: 'running',
	mode: 'upload',
	startedMs: Date.now() - 60_000,
	startedAt: new Date().toISOString(),
	pid: 999999,
}));
const sr2 = await import(new URL('../lib/syncrun.mjs?fresh=' + Date.now(), import.meta.url).href);
const deadState = sr2.syncState();
assert.equal(deadState.running, false, 'dead job is not running');
assert.equal(deadState.orphan, null, 'dead pid is not treated as orphan');
const rewritten = JSON.parse(fs.readFileSync(sr2.syncJobPath(), 'utf8'));
assert.equal(rewritten.phase, 'interrupted', 'dead running job rewritten to interrupted');
assert.match(String(rewritten.result || ''), /中断/, 'interrupted job explains itself');

// pid 还活着 -> 认作遗留任务（orphan），卡片给「结束任务」按钮
fs.writeFileSync(sr.syncJobPath(), JSON.stringify({
	phase: 'running',
	mode: 'upload',
	startedMs: Date.now() - 60_000,
	startedAt: new Date().toISOString(),
	pid: process.pid,
}));
const sr3 = await import(new URL('../lib/syncrun.mjs?fresh2=' + Date.now(), import.meta.url).href);
const liveState = sr3.syncState();
assert.equal(liveState.running, false, 'orphan is not reported as running');
assert.ok(liveState.orphan && liveState.orphan.pid === process.pid, 'alive pid becomes an orphan warning');
assert.equal((await call(base + '/sync/cancel', { method: 'POST', body: {} })).status, 200, 'cancel still answers for a stale job');
fs.rmSync(sr.syncJobPath(), { force: true });

const badRestore = await call(base + '/restore', { method: 'POST', body: { pkg: '/definitely/not/here' } });
assert.equal(badRestore.status, 409, 'restore without a real package -> 409');
assert.match(badRestore.json.error, /找不到包/);

// 非 loopback 拒绝
const handler = routes.get(base + '/status');
const denied = await new Promise((resolve) => {
  const req = { method: 'GET', url: base + '/status', socket: { remoteAddress: '10.0.0.9' }, on() {}, destroy() {} };
  const res = { writeHead(s, h) { this.statusCode = s; }, end(t) { resolve({ status: this.statusCode, text: t }); } };
  handler(req, res);
});
assert.equal(denied.status, 403, 'non-loopback forbidden');
assert.match(denied.text, /forbidden/);

// ---- 浏览器半侧：在 vm 里加载 client.js，用最小 react 替身 ----
const clientSrc = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
let captured = null;
const fakeReact = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
};
const fakeJsx = (type, props) => ({ type, props: props || {} });
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  window: {
    __ModuleLoader__: {
      load(spec) {
        captured = spec;
      },
    },
  },
};
vm.createContext(sandbox);
vm.runInContext(clientSrc, sandbox, { filename: 'client.js' });
assert.ok(captured, 'client bundle called __ModuleLoader__.load');
assert.equal(captured.id, 'dsh-aliyunpan-backup', 'client id = package name');
const clientModule = captured.factory((name) => {
  if (name === 'react') return fakeReact;
  if (name === 'react/jsx-runtime') return { jsx: fakeJsx, jsxs: fakeJsx, Fragment: fakeReact.Fragment };
  throw new Error('unexpected require: ' + name);
});
assert.equal(typeof clientModule.apply, 'function', 'client apply');
assert.ok(Array.isArray(clientModule.inject), 'client inject');

const registrations = [];
const clientCtx = {
  inject(deps, cb) {
    assert.ok(Array.isArray(deps));
    cb({ slots: { inject(_seat, factory) { registrations.push(factory()); }, register(_spec, _component) { return () => {}; } } });
  },
};
clientModule.apply(clientCtx);
assert.equal(registrations.length, 2, 'both seats registered');

// 记录两个席位的注册规格 + 组件
const specs = [];
let component = null;
const ctx2 = {
  inject(deps, cb) {
    cb({
      slots: {
        inject: (_seat, factory) => factory(),
        register: (spec, comp) => {
          specs.push(spec);
          component = comp;
          return () => {};
        },
      },
    });
  },
};
clientModule.apply(ctx2);
const byName = new Map(specs.map((s) => [s.name, s]));
assert.ok(byName.has('plugins.bundle.config'), 'registers the official per-bundle config seat');
assert.equal(byName.get('plugins.bundle.config').key, 'dsh-aliyunpan-backup', 'config seat keyed by package name');
assert.ok(byName.has('plugins.detail.section'), 'registers the detail section too');
assert.equal(byName.get('plugins.detail.section').id, 'aliyunpan-backup', 'detail section id');

assert.equal(typeof component, 'function', 'component fn');
assert.equal(component({ subject: { kind: 'bundle', pkg: { name: 'other-plugin' } } }), null, 'other bundle -> null');
assert.ok(component(undefined), 'config seat (no subject) -> renders');
const rendered = component({ subject: { kind: 'bundle', pkg: { name: 'dsh-aliyunpan-backup', installed: true } } });
assert.ok(rendered, 'own bundle -> renders');
assert.equal(typeof rendered.type, 'function', 'renders the inner component');
const inner = rendered.type();
assert.equal(inner.type, 'section', 'inner renders a <section>');
const textOf = (node) => {
  if (node === null || node === undefined || node === false) return '';
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node === 'object') return textOf(node.props && node.props.children);
  return String(node);
};
const blob = textOf(inner);
assert.match(blob, /阿里云盘同步/, 'panel shows title');
assert.doesNotMatch(blob, /立即备份并上传/, 'backup button gone');
assert.match(blob, /同步上传/, 'panel offers one-click sync upload');
assert.match(blob, /从机拉取/, 'panel offers pull');
assert.match(blob, /打开完整配置页/, 'panel shows the full page toggle');
assert.match(blob, /复制配置页地址/, 'panel offers a copy-link fallback');
assert.match(blob, /可解码的包/, 'panel mentions the decode capability');
// 宿主里 target=_blank 会被弹窗策略拦掉：配置页改为卡片内嵌 iframe（点击前不渲染），
// 因此这里断言「没有外链 anchor」。
const hrefs = [];
const walk = (node) => {
  if (node === null || node === undefined || node === false) return;
  if (Array.isArray(node)) return node.forEach(walk);
  if (typeof node !== 'object') return;
  if (node.props && typeof node.props.href === 'string') hrefs.push(node.props.href);
  walk(node.props && node.props.children);
};
walk(inner);
assert.deepEqual(hrefs, [], 'no target=_blank anchor (popup-blocked in the host)');


// ---- 云端 profile 自动发现（0.5.2）：下载时按云端实际名字拼路径，落地名按 1:1 规则映射 ----
const cfgMod = await import(new URL('../lib/config.mjs', import.meta.url).href);
const fakeDsh = path.join(tmpHome, 'dsh-fake');
fs.mkdirSync(path.join(fakeDsh, 'profiles', 'solo'), { recursive: true });
fs.writeFileSync(path.join(tmpHome, 'config.json'), JSON.stringify({ dshHome: fakeDsh }), 'utf8');
const cfgNow = cfgMod.readConfig();
assert.equal(cfgNow.dshHome, fakeDsh, 'readConfig honours config.json dshHome');

const oneToOne = cfgMod.syncRoots(cfgNow, { profiles: ['desktop'] });
const mappedFiles = oneToOne.filter((r) => r.kind === 'file' && r.profile);
assert.ok(mappedFiles.length >= 4, 'profile file roots exist: ' + mappedFiles.length);
assert.ok(mappedFiles.every((r) => r.profile === 'desktop'), 'remote keeps the cloud name');
assert.ok(mappedFiles.every((r) => r.localProfile === 'solo'), '1:1 mapping lands on the local profile');
assert.ok(mappedFiles.every((r) => r.local.includes(path.join('profiles', 'solo'))), 'local path uses the local profile');
assert.ok(mappedFiles.every((r) => r.remote.endsWith('/profiles/desktop/' + path.basename(r.local))), 'remote path uses the cloud profile');
assert.ok(mappedFiles.every((r) => /只有一个 profile/.test(r.note)), '1:1 mapping is explained in the note');
// 云端有多个 profile 时不能映射到唯一本机 profile（会互相覆盖），各建各的目录
const manyRemote = cfgMod.syncRoots(cfgNow, { profiles: ['desktop', 'web'] });
const manyFiles = manyRemote.filter((r) => r.kind === 'file' && r.profile);
assert.ok(manyFiles.every((r) => r.localProfile === r.profile), 'multiple cloud profiles keep their own names');
assert.deepEqual([...new Set(manyFiles.map((r) => r.profile))].sort(), ['desktop', 'web'], 'both cloud profiles are covered');
// 目录根不带 profile 字段（回归：别把 dir 也当成装配文件）
assert.ok(oneToOne.filter((r) => r.kind === 'dir').every((r) => r.profile === undefined), 'dir roots have no profile field');


// ---- 密钥信封（0.5.3）：凭据加密后单独上传，云端只有密文 ----
const envMod = await import(new URL('../lib/envelope.mjs', import.meta.url).href);
const pass = 'smoke-passphrase-42';
const sealed = envMod.seal('refs:\n  - LISSOM_API_KEY\n', pass);
assert.equal(sealed.subarray(0, 8).toString('latin1'), 'DSHKEY01', 'envelope magic');
assert.equal(sealed.toString('latin1').includes('LISSOM_API_KEY'), false, 'ciphertext does not leak plaintext');
assert.equal(envMod.open(sealed, pass).toString('utf8'), 'refs:\n  - LISSOM_API_KEY\n', 'envelope round trip');
assert.throws(() => envMod.open(sealed, 'wrong-passphrase-99'), /口令不对/, 'wrong passphrase rejected');
const tampered = Buffer.from(sealed);
tampered[tampered.length - 1] ^= 0xff;
assert.throws(() => envMod.open(tampered, pass), /口令不对/, 'tampered tag rejected');
assert.throws(() => envMod.open(Buffer.from('not-an-envelope-at-all'), pass), /信封太短|magic/, 'garbage rejected');

const envHome = path.join(tmpHome, "dsh-env");
fs.mkdirSync(envHome, { recursive: true });
const keyPath = path.join(tmpHome, "env-KEY.txt");
fs.writeFileSync(keyPath, pass + "\n", "utf8");
const credPath = envMod.credentialsPath(envHome);
fs.writeFileSync(credPath, "refs:\n  - LISSOM_API_KEY\n", "utf8");
assert.equal(envMod.hasPass(keyPath), true, "hasPass true with a key file");
assert.equal(envMod.hasPass(path.join(tmpHome, "missing-KEY.txt")), false, "hasPass false without a key file");
assert.throws(() => envMod.readPass(path.join(tmpHome, "missing-KEY.txt")), /读不到口令文件/, "missing key file error");
fs.writeFileSync(path.join(tmpHome, "short-KEY.txt"), "short\n", "utf8");
assert.throws(() => envMod.readPass(path.join(tmpHome, "short-KEY.txt")), /口令太短/, "short passphrase rejected");

const sealedFile = envMod.sealFile(envHome, keyPath);
assert.ok(Buffer.isBuffer(sealedFile) && sealedFile.length > 36, "sealFile returns an envelope");
// 本机凭据被改过：解密回写要改成旧内容，并先备份

fs.writeFileSync(credPath, "refs:\n  - CHANGED\n", "utf8");
const restored = envMod.openToFile(sealedFile, keyPath, credPath);
assert.equal(restored.changed, true, "openToFile rewrites when content differs");
assert.ok(restored.backup && fs.existsSync(restored.backup), "previous credentials are backed up");
assert.match(fs.readFileSync(restored.backup, "utf8"), /CHANGED/, "backup keeps the old content");
assert.match(fs.readFileSync(credPath, "utf8"), /LISSOM_API_KEY/, "credentials restored from the envelope");
const twice = envMod.openToFile(sealedFile, keyPath, credPath);
assert.equal(twice.changed, false, "same content -> no rewrite, no backup");
assert.equal(twice.backup, "", "no backup when nothing changed");

// 缺凭据的机器上 sealFile 要给可读错误，而不是崩
assert.throws(() => envMod.sealFile(path.join(tmpHome, "emptydsh"), keyPath), /不需要同步凭据/, "sealFile without credentials");

// /status 暴露信封状态，开关能存进配置
const envStatus = await call(base + "/status");
assert.equal(typeof envStatus.json.envelope.enabled, "boolean", "/status exposes envelope.enabled");
assert.equal(typeof envStatus.json.envelope.keyReady, "boolean", "/status exposes envelope.keyReady");
assert.ok(envStatus.json.envelope.remotePath.endsWith("/.credentials.yaml.enc"), "remote envelope path: " + envStatus.json.envelope.remotePath);
assert.equal(envStatus.json.envelope.keyFile, envStatus.json.view.keyFile, "envelope reports the configured key file");
const envOn = await call(base + "/config", { method: "POST", body: { credentialsEnvelope: true } });
assert.equal(envOn.json.config.credentialsEnvelope, true, "credentialsEnvelope saved");
const envStatusOn = await call(base + "/status");
assert.equal(envStatusOn.json.envelope.enabled, true, "envelope switch is visible in /status");
// ---- 工作区路径重映射（0.5.4）：换机器后 D:\... 不存在时改到本机能找到的位置 ----
const wsMod = await import(new URL('../lib/workspace.mjs', import.meta.url).href);
const rules = wsMod.parseMap('# 注释行会被忽略\nD:\\Code=>C:\\Work\\Code\nE:\\Old -> F:\\New\n坏行没有箭头');
assert.equal(rules.length, 2, 'parseMap reads two rules: ' + JSON.stringify(rules));
assert.equal(rules[0].from, 'D:\\Code', 'first rule from');
assert.equal(rules[1].to, 'F:\\New', 'second rule to (-> syntax)');

const existSet = new Set(['C:\\Work\\Code\\deepseek', 'D:\\Proj\\app', path.join(tmpHome, 'Documents', 'life')]);
const fakeExists = (p) => existSet.has(p);
const planA = wsMod.planRemap([
  { id: 'a', title: '本地有', path: 'C:\\Work\\Code\\deepseek' },
  { id: 'b', title: '要换盘符', path: 'X:\\Proj\\app' },
  { id: 'c', title: '靠手动映射', path: 'D:\\Code\\deepseek' },
  { id: 'd', title: '找不到', path: 'Y:\\Nope\\zzz' },
], { exists: fakeExists, map: rules, drives: ['D:'], home: tmpHome });
assert.equal(planA.changes.length, 2, 'two paths can be remapped: ' + JSON.stringify(planA.changes));
assert.equal(planA.skipped.length, 1, 'existing path is skipped');
assert.equal(planA.unresolved.length, 1, 'hopeless path is reported unresolved');
const byId = new Map(planA.changes.map((c) => [c.id, c]));
assert.equal(byId.get('b').to, 'D:\\Proj\\app', 'drive swap candidate');
assert.match(byId.get('b').why, /换盘符/, 'drive swap reason');
assert.equal(byId.get('c').to, 'C:\\Work\\Code\\deepseek', 'manual prefix map candidate');
assert.match(byId.get('c').why, /手动映射/, 'manual map reason');

const remapHome = path.join(tmpHome, 'dsh-remap');
const keepDir = path.join(remapHome, 'keep-me');
const mappedDir = path.join(remapHome, 'mapped', 'proj');
fs.mkdirSync(keepDir, { recursive: true });
fs.mkdirSync(mappedDir, { recursive: true });
fs.mkdirSync(path.join(remapHome, 'storages'), { recursive: true });
const wsFile = path.join(remapHome, 'storages', 'workspace.json');
fs.writeFileSync(wsFile, JSON.stringify({ tables: { workspaces: {
  w1: { path: keepDir, title: '保留', sessionIds: [] },
  w2: { path: 'X:\\Ghost\\proj', title: '映射', sessionIds: [] },
  w3: { path: 'Y:\\Nope\\zzz', title: '无解', sessionIds: [] },
} } }), 'utf8');
const report = wsMod.remapWorkspaces({ dshHome: remapHome, workspaceMap: 'X:\\Ghost=>' + path.join(remapHome, 'mapped') });
assert.equal(report.remapped.length, 1, 'one workspace remapped: ' + JSON.stringify(report.remapped));
assert.equal(report.unresolved.length, 1, 'one workspace unresolved');
assert.ok(report.backup && fs.existsSync(report.backup), 'workspace.json backed up before rewrite');
const after = JSON.parse(fs.readFileSync(wsFile, 'utf8'));
assert.equal(after.tables.workspaces.w1.path, keepDir, 'existing path untouched');
assert.equal(after.tables.workspaces.w2.path, mappedDir, 'mapped path rewritten');
assert.equal(after.tables.workspaces.w3.path, 'Y:\\Nope\\zzz', 'unresolved path kept as-is');
assert.equal(after.tables.workspaces.w2.title, '映射', 'other fields preserved');
assert.ok(fs.existsSync(path.join(remapHome, 'workspace-remap.json')), 'remap report written');
const again = wsMod.remapWorkspaces({ dshHome: remapHome, workspaceMap: 'X:\\Ghost=>' + path.join(remapHome, 'mapped') });
assert.equal(again.remapped.length, 0, 'second run is a no-op');
assert.equal(again.backup, '', 'no backup when nothing changes');

const wsStatus = await call(base + '/status');
assert.equal(typeof wsStatus.json.workspace.remap, 'boolean', '/status exposes workspace.remap');
assert.equal(typeof wsStatus.json.workspace.total, 'number', '/status exposes workspace.total');
assert.equal(Array.isArray(wsStatus.json.workspace.missing), true, '/status exposes workspace.missing');
const wsConfig = await call(base + '/config', { method: 'POST', body: { workspaceRemap: false, workspaceMap: 'D:\\Code=>C:\\Code', syncProfileExclude: 'abtest, tmp' } });
assert.equal(wsConfig.json.config.workspaceRemap, false, 'workspaceRemap saved');
assert.equal(wsConfig.json.config.syncProfileExclude, 'abtest, tmp', 'syncProfileExclude saved');
const cfgAfter = cfgMod.readConfig();
assert.equal(cfgAfter.workspaceRemap, false, 'workspaceRemap normalised');
assert.deepEqual(cfgMod.profileExcludeList(cfgAfter), ['abtest', 'tmp'], 'excluded profiles parsed');
assert.equal(cfgMod.profileNames(cfgAfter).includes('abtest'), false, 'excluded profile is not synced');

console.log('SMOKE OK  routes=' + routes.size + '  home=' + tmpHome);
