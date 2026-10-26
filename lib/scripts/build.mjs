import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// 配置来源：插件宿主通过 DSH_AB_CONFIG 传 config.json；独立运行时用默认值。
const CFG = (() => {
  try {
    const p = process.env.DSH_AB_CONFIG;
    if (p && fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  return {};
})();

const DSH_HOME = CFG.dshHome || path.join(os.homedir(), '.dsh');
const ROOT = CFG.stagingDir || (fs.existsSync('D:\\DSH-Backup') ? 'D:\\DSH-Backup' : path.join(os.homedir(), '.dsh', 'dsh-aliyunpan-backup', 'staging'));
const KEY_FILE = CFG.keyFile || path.join(ROOT, 'KEY.txt');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.pnpm-store', 'cache', 'backups']);
const INCLUDE_DIRS = new Set(['storages', 'task-board', 'feishu', 'eda', 'skins', 'sessions', 'attachments']);
const PROFILE_FILES = /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|cordis\.patch\.yml|.*\.patch\.yml(\..*)?|\.npmrc)$/;
const SMALL_CFG = /\.(json|ya?ml|toml|txt|md)$/i;
// feishu\files（收到的文档/压缩包）默认不收：配置 includeFeishuFiles=true 或传 --feishu-files 才收，
// 传 --no-feishu-files 始终排除（约省 270MB）。
const WITH_FEISHU_FILES =
  !process.argv.includes('--no-feishu-files') &&
  (CFG.includeFeishuFiles === true || process.argv.includes('--feishu-files'));

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const stamp = now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + 'T' + pad(now.getHours()) + pad(now.getMinutes());
const snapId = stamp + '-full';
const work = path.join(ROOT, 'work', snapId);
const out = path.join(ROOT, 'snapshots', snapId);
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(out, { recursive: true });

let generated = false; let pass;
if (fs.existsSync(KEY_FILE)) pass = fs.readFileSync(KEY_FILE, 'utf8').trim();
else { generated = true; pass = crypto.randomBytes(18).toString('base64url').slice(0, 24); fs.writeFileSync(KEY_FILE, pass + '\n', 'utf8'); }

const files = [];
function walk(absDir, relParts) {
  let ents; try { ents = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const rel = relParts.concat(e.name); const abs = path.join(absDir, e.name); const seg0 = rel[0];
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (rel.length === 1 && !(INCLUDE_DIRS.has(seg0) || seg0 === 'pets' || seg0 === 'profiles' || seg0 === 'sources')) continue;
      if (seg0 === 'pets' && rel.length >= 2) continue;
      if (seg0 === 'profiles' && rel.length >= 3) continue;
      if (seg0 === 'sources' && rel.length >= 3) continue;
      walk(abs, rel); continue;
    }
    if (!e.isFile()) continue;
    if (rel.length > 1) {
      if (seg0 === 'pets') { if (!/\.json$/i.test(e.name)) continue; }
      else if (seg0 === 'profiles') { if (rel.length !== 2) continue; if (!PROFILE_FILES.test(e.name) && !SMALL_CFG.test(e.name)) continue; }
      else if (seg0 === 'sources') { if (rel.length > 2 && !SMALL_CFG.test(e.name)) continue; }
      else if (seg0 === 'feishu' && rel.length > 2 && rel[1] === 'files' && !WITH_FEISHU_FILES) continue;
    }
    let st; try { st = fs.statSync(abs); } catch { continue; }
    if (!st.isFile()) continue;
    files.push({ rel: rel.join('\\'), abs, bytes: st.size });
  }
}
walk(DSH_HOME, []);
files.sort((a, b) => a.rel.localeCompare(b.rel));
const totalBytes = files.reduce((s, f) => s + f.bytes, 0);
console.log('[1/5] scanned fileCount=' + files.length + ' totalBytes=' + totalBytes + ' (' + (totalBytes / 1048576).toFixed(1) + ' MB)');

const hbuf = Buffer.allocUnsafe(1 << 20);
const manifest = {
  schema: 'dsh-backup/2', snapshotId: snapId, variant: 'full-encrypted', createdAt: now.toISOString(),
  sourceMachine: process.env.COMPUTERNAME || 'unknown', dshHome: DSH_HOME,
  fileCount: files.length, totalBytes,
  encryption: { algo: 'aes-256-gcm', kdf: 'scrypt(N=32768,r=8,p=1)', chunk: 1048576 },
  files: []
};
for (const f of files) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(f.abs, 'r');
  let n; while ((n = fs.readSync(fd, hbuf, 0, hbuf.length, null)) > 0) h.update(hbuf.subarray(0, n));
  fs.closeSync(fd);
  manifest.files.push({ path: f.rel, bytes: f.bytes, sha256: h.digest('hex') });
}
const manifestJson = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
fs.writeFileSync(path.join(work, 'manifest.json'), manifestJson);
console.log('[2/5] manifest ok (' + manifestJson.length + ' bytes)');

// ---- bundle (自定义容器，避免 Windows tar 的 Unicode 路径问题) ----
const bundlePath = path.join(work, 'payload.bundle');
const fd = fs.openSync(bundlePath, 'w');
const w = (b) => fs.writeSync(fd, b);
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
w(Buffer.from('DSHBUNDLE1\n', 'latin1'));
w(u32(files.length + 1));
function entry(name, sizeBuf, srcAbs) {
  const nb = Buffer.from(name, 'utf8');
  w(u32(nb.length)); w(nb); w(sizeBuf);
  if (srcAbs) {
    const rfd = fs.openSync(srcAbs, 'r');
    let n; while ((n = fs.readSync(rfd, hbuf, 0, hbuf.length, null)) > 0) w(hbuf.subarray(0, n));
    fs.closeSync(rfd);
  }
}
entry('manifest.json', u64(manifestJson.length), null);
w(manifestJson);
for (const f of files) entry(f.rel, u64(f.bytes), f.abs);
fs.closeSync(fd);
const bundleSize = fs.statSync(bundlePath).size;
console.log('[3/5] bundle=' + (bundleSize / 1048576).toFixed(1) + ' MB');

// ---- encrypt ----
const CHUNK = 1048576;
const salt = crypto.randomBytes(16);
const key = crypto.scryptSync(pass, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 96 * 1048576 });
const noncePrefix = crypto.randomBytes(4);
const totalChunks = Math.ceil(bundleSize / CHUNK);
const encPath = path.join(out, 'payload.enc');
const fdOut = fs.openSync(encPath, 'w');
const header = Buffer.alloc(8 + 16 + 4 + 8);
header.write('DSHBK002', 0, 'latin1'); salt.copy(header, 8); noncePrefix.copy(header, 24);
header.writeBigUInt64LE(BigInt(bundleSize), 28);
fs.writeSync(fdOut, header);
const fdIn = fs.openSync(bundlePath, 'r');
const plain = Buffer.allocUnsafe(CHUNK);
let idx = 0;
while (idx < totalChunks) {
  const n = fs.readSync(fdIn, plain, 0, CHUNK, idx * CHUNK);
  const nonce = Buffer.alloc(12); noncePrefix.copy(nonce, 0); nonce.writeUInt32BE(idx, 4);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from('dshbk-chunk-' + idx, 'utf8'));
  const ct = Buffer.concat([c.update(plain.subarray(0, n)), c.final()]);
  fs.writeSync(fdOut, Buffer.concat([c.getAuthTag(), ct]));
  idx++;
}
fs.closeSync(fdIn); fs.closeSync(fdOut);
const encSize = fs.statSync(encPath).size;
const hd = crypto.createHash('sha256'); const rfd2 = fs.openSync(encPath, 'r');
let n2; while ((n2 = fs.readSync(rfd2, hbuf, 0, hbuf.length, null)) > 0) hd.update(hbuf.subarray(0, n2));
fs.closeSync(rfd2);
const encSha256 = hd.digest('hex');
console.log('[4/5] encrypted chunks=' + totalChunks + ' size=' + (encSize / 1048576).toFixed(1) + ' MB');
fs.writeFileSync(path.join(out, 'package.info.json'), JSON.stringify({
  schema: 'dsh-backup-outer/2', snapshotId: snapId, variant: 'full-encrypted', createdAt: now.toISOString(),
  sourceMachine: manifest.sourceMachine, dshHome: DSH_HOME, fileCount: files.length, totalBytes,
  bundleBytes: bundleSize, encBytes: encSize, encSha256,
  container: 'DSHBUNDLE1', kdf: 'scrypt(N=32768,r=8,p=1)', chunk: CHUNK,
  passSource: generated ? 'generated-this-run' : 'existing-keyfile',
  note: 'payload.enc 用 KEY.txt 口令解密；manifest.json 是包内第一个条目。'
}, null, 2), 'utf8');
fs.rmSync(bundlePath, { force: true });
fs.rmSync(work, { recursive: true, force: true });
console.log('[5/5] done -> ' + out);
console.log('SNAPSHOT=' + snapId + ' FILES=' + (files.length + 1) + ' RAW=' + totalBytes);
console.log('PASS_GENERATED=' + generated);
