import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// usage:
//   node restore.mjs --pkg <dir containing payload.enc> --key <KEY.txt|passphrase> --out <dir> [--verify-only]
const args = process.argv.slice(2);
const get = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const pkgDir = get('pkg');
const CFG = (() => {
  try {
    const p = process.env.DSH_AB_CONFIG;
    if (p && fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  return {};
})();
// 暂存目录：配置优先 → 本机遗留 D:\ 目录（存在才用）→ 插件数据目录（跨机一致）
const HOME = process.env.DSH_AB_HOME || path.join(os.homedir(), '.dsh', 'dsh-aliyunpan-backup');
const LEGACY = 'D:\\DSH-Backup';
const staging = CFG.stagingDir || (fs.existsSync(LEGACY) ? LEGACY : path.join(HOME, 'staging'));
const keyArg = get('key', CFG.keyFile || path.join(staging, 'KEY.txt'));
const outDir = get('out');
const verifyOnly = args.includes('--verify-only');
if (!pkgDir) { console.error('need --pkg'); process.exit(2); }

let pass = keyArg;
if (fs.existsSync(keyArg)) pass = fs.readFileSync(keyArg, 'utf8').trim();

const encPath = path.join(pkgDir, 'payload.enc');
const fd = fs.openSync(encPath, 'r');
const header = Buffer.alloc(36);
fs.readSync(fd, header, 0, 36, 0);
if (header.subarray(0, 8).toString('latin1') !== 'DSHBK002') { console.error('bad magic'); process.exit(3); }
const salt = header.subarray(8, 24);
const noncePrefix = header.subarray(24, 28);
const plainBytes = Number(header.readBigUInt64LE(28));
const CHUNK = 1048576;
const totalChunks = Math.ceil(plainBytes / CHUNK);
const key = crypto.scryptSync(pass, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 96 * 1048576 });
console.log('payload: ' + plainBytes + ' bytes, chunks=' + totalChunks);

// 解密到临时 bundle 文件
const tmpBundle = path.join(pkgDir, '.restore-tmp.bundle');
const fdo = fs.openSync(tmpBundle, 'w');
let off = 36;
const tag = Buffer.alloc(16);
const acc = Buffer.allocUnsafe(CHUNK);
for (let i = 0; i < totalChunks; i++) {
  fs.readSync(fd, tag, 0, 16, off); off += 16;
  const want = Math.min(CHUNK, plainBytes - i * CHUNK);
  const buf = Buffer.allocUnsafe(want);
  fs.readSync(fd, buf, 0, want, off); off += want;
  const nonce = Buffer.alloc(12); noncePrefix.copy(nonce, 0); nonce.writeUInt32BE(i, 4);
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  d.setAAD(Buffer.from('dshbk-chunk-' + i, 'utf8'));
  d.setAuthTag(tag);
  let pt;
  try { pt = Buffer.concat([d.update(buf), d.final()]); }
  catch (e) { console.error('AUTH FAIL at chunk ' + i + ' (口令错误或包损坏)'); process.exit(4); }
  fs.writeSync(fdo, pt);
}
fs.closeSync(fdo); fs.closeSync(fd);
console.log('decrypt ok');

// 解析 bundle
const bfd = fs.openSync(tmpBundle, 'r');
const pos = { v: 0 };
const readAt = (len, at) => { const b = Buffer.allocUnsafe(len); fs.readSync(bfd, b, 0, len, at); return b; };
const magic = readAt(11, 0).toString('latin1');
if (magic !== 'DSHBUNDLE1\n') { console.error('bad bundle magic: ' + JSON.stringify(magic)); process.exit(5); }
let p = 11;
const cnt = readAt(4, p).readUInt32LE(0); p += 4;
console.log('entries=' + cnt);
const entries = [];
for (let i = 0; i < cnt; i++) {
  const nl = readAt(4, p).readUInt32LE(0); p += 4;
  const name = readAt(nl, p).toString('utf8'); p += nl;
  const size = Number(readAt(8, p).readBigUInt64LE(0)); p += 8;
  entries.push({ name, size, dataPos: p });
  p += size;
}
const manifestEntry = entries.find((e) => e.name === 'manifest.json');
const manifest = JSON.parse(readAt(manifestEntry.size, manifestEntry.dataPos).toString('utf8'));
console.log('manifest: files=' + manifest.fileCount + ' bytes=' + manifest.totalBytes);

const hashAt = (at, len) => {
  const h = crypto.createHash('sha256');
  const b = Buffer.allocUnsafe(1 << 20);
  let done = 0;
  while (done < len) {
    const n = Math.min(b.length, len - done);
    fs.readSync(bfd, b, 0, n, at + done); h.update(b.subarray(0, n)); done += n;
  }
  return h.digest('hex');
};

if (verifyOnly) {
  let bad = 0, ok = 0, missing = 0;
  const byName = new Map(entries.map((e) => [e.name, e]));
  for (const f of manifest.files) {
    const e = byName.get(f.path);
    if (!e) { missing++; console.log('MISSING ' + f.path); continue; }
    const h = hashAt(e.dataPos, e.size);
    if (h !== f.sha256) { bad++; if (bad <= 10) console.log('HASH MISMATCH ' + f.path); } else ok++;
  }
  console.log('verify: ok=' + ok + ' bad=' + bad + ' missing=' + missing);
  fs.closeSync(bfd); fs.unlinkSync(tmpBundle);
  process.exit(bad || missing ? 6 : 0);
}

if (!outDir) { console.error('need --out (or --verify-only)'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
let n = 0;
for (const e of entries) {
  if (e.name === 'manifest.json') continue;
  // bundle 内路径用反斜杠记录；在非 Windows 上落到单文件名会丢目录结构 → 统一按两种分隔符切开
  const dest = path.join(outDir, ...e.name.split(/[\\/]+/).filter(Boolean));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const wfd = fs.openSync(dest, 'w');
  const b = Buffer.allocUnsafe(1 << 20);
  let done = 0;
  while (done < e.size) {
    const k = Math.min(b.length, e.size - done);
    fs.readSync(bfd, b, 0, k, e.dataPos + done);
    fs.writeSync(wfd, b, 0, k);
    done += k;
  }
  fs.closeSync(wfd);
  n++;
}
fs.writeFileSync(path.join(outDir, 'RESTORE-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
fs.closeSync(bfd); fs.unlinkSync(tmpBundle);
console.log('extracted=' + n + ' -> ' + outDir);