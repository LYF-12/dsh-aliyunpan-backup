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
assert.equal(routes.size, 20, 'exactly 20 routes');

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

console.log('SMOKE OK  routes=' + routes.size + '  home=' + tmpHome);
