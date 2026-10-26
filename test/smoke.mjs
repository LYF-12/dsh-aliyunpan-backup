import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ab-'));
process.env.DSH_AB_HOME = tmpHome;

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

const config = await call(base + '/config');
assert.equal(config.status, 200, 'GET /config status');
assert.equal(config.json.ok, true);
assert.equal(config.json.config.keep, 3, 'default keep');
assert.ok(config.json.view.stagingDir, 'staging dir resolved');
assert.ok(config.json.view.remoteDir.startsWith('/'), 'remote dir');

const saved = await call(base + '/config', { method: 'POST', body: { keep: 7, includeFeishuFiles: true, remoteDir: '/DeepSeek Harness/DSH-Backup', bogus: 1 } });
assert.equal(saved.status, 200, 'POST /config status');
assert.equal(saved.json.config.keep, 7, 'keep saved');
assert.equal(saved.json.config.includeFeishuFiles, true, 'feishu saved');
assert.equal(saved.json.config.bogus, undefined, 'unknown key rejected');
assert.ok(fs.existsSync(path.join(tmpHome, 'config.json')), 'config file written');

const badSave = await call(base + '/config', { method: 'POST', body: { keep: 'abc' } });
assert.equal(badSave.status, 400, 'no valid fields -> 400');

const status = await call(base + '/status');
assert.equal(status.status, 200);
assert.equal(status.json.state.running, false, 'idle');
assert.ok(Array.isArray(status.json.snapshots), 'snapshots array');
assert.equal(typeof status.json.log.text, 'string', 'log text');

const ui = await call(base + '/ui');
assert.equal(ui.status, 200);
assert.match(ui.headers['content-type'], /text\/html/);
assert.match(ui.text, /阿里云盘备份/);
assert.match(ui.text, /\/api\/dsh-aliyunpan-backup/);

const log = await call(base + '/log', { url: base + '/log?lines=5' });
assert.equal(log.status, 200);
assert.ok(Array.isArray(log.json.lines), 'log lines array');

const badMode = await call(base + '/run', { method: 'POST', body: { mode: 'nope' } });
assert.equal(badMode.status, 400, 'bad mode rejected');

const badRestore = await call(base + '/restore', { method: 'POST', body: { snapshot: '/definitely/not/here' } });
assert.equal(badRestore.status, 409, 'restore without snapshot -> 409');
assert.match(badRestore.json.error, /找不到快照/);

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
// 内层组件（hooks 由替身提供）应产出 section
const inner = rendered.type();
assert.equal(inner.type, 'section', 'inner renders a <section>');
const textOf = (node) => {
  if (node === null || node === undefined || node === false) return '';
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node === 'object') return textOf(node.props && node.props.children);
  return String(node);
};
const blob = textOf(inner);
assert.match(blob, /阿里云盘备份/, 'panel shows title');
assert.match(blob, /立即备份并上传/, 'panel shows run button');
assert.match(blob, /打开完整配置页/, 'panel shows the full page link');
const hrefs = [];
const walk = (node) => {
  if (node === null || node === undefined || node === false) return;
  if (Array.isArray(node)) return node.forEach(walk);
  if (typeof node !== 'object') return;
  if (node.props && typeof node.props.href === 'string') hrefs.push(node.props.href);
  walk(node.props && node.props.children);
};
walk(inner);
assert.deepEqual(hrefs, ['/api/dsh-aliyunpan-backup/ui'], 'panel links the full page');

console.log('SMOKE OK  routes=' + routes.size + '  home=' + tmpHome);
