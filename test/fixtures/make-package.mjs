import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 生成一个与旧版备份包同格式的 payload.enc（DSHBK002 容器 + DSHBUNDLE1 明文 bundle）。
 * 包格式：
 *   header 36B = "DSHBK002" | salt16 | noncePrefix4 | plainBytes(u64LE)
 *   每 1MiB 明文一块：tag16 | ciphertext
 *   AAD = "dshbk-chunk-<i>"，nonce = noncePrefix + u32BE(i) + 0u32
 *   key = scrypt(passphrase, salt, 32, N=32768,r=8,p=1)
 *   bundle 明文 = "DSHBUNDLE1\n" | u32 count | [u32 nameLen | name | u64 size | data]*
 *   其中必须含 manifest.json（restore 用它按 sha256 逐文件校验）
 */
const CHUNK = 1048576;

export function buildBundle(files) {
  const parts = [];
  const add = (buf) => parts.push(buf);
  const manifest = { fileCount: files.length, totalBytes: 0, files: [] };
  const payload = [];
  for (const file of files) {
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    manifest.files.push({ path: file.path, size: data.length, sha256 });
    manifest.totalBytes += data.length;
    payload.push({ path: file.path, data });
  }
  const manifestBuf = Buffer.from(JSON.stringify(manifest), 'utf8');
  const entries = [{ path: 'manifest.json', data: manifestBuf }].concat(payload);
  add(Buffer.from('DSHBUNDLE1\n', 'latin1'));
  const count = Buffer.alloc(4);
  count.writeUInt32LE(entries.length, 0);
  add(count);
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    const nameLen = Buffer.alloc(4);
    nameLen.writeUInt32LE(name.length, 0);
    const size = Buffer.alloc(8);
    size.writeBigUInt64LE(BigInt(entry.data.length), 0);
    add(nameLen);
    add(name);
    add(size);
    add(entry.data);
  }
  return { bundle: Buffer.concat(parts), manifest };
}

export function encryptBundle(bundle, passphrase) {
  const salt = crypto.randomBytes(16);
  const noncePrefix = crypto.randomBytes(4);
  const key = crypto.scryptSync(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 96 * 1048576 });
  const header = Buffer.alloc(36);
  header.write('DSHBK002', 0, 'latin1');
  salt.copy(header, 8);
  noncePrefix.copy(header, 24);
  header.writeBigUInt64LE(BigInt(bundle.length), 28);
  const out = [header];
  for (let i = 0; i * CHUNK < bundle.length; i++) {
    const slice = bundle.subarray(i * CHUNK, Math.min(bundle.length, (i + 1) * CHUNK));
    const nonce = Buffer.alloc(12);
    noncePrefix.copy(nonce, 0);
    nonce.writeUInt32BE(i, 4);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from('dshbk-chunk-' + i, 'utf8'));
    const body = Buffer.concat([cipher.update(slice), cipher.final()]);
    out.push(cipher.getAuthTag(), body);
  }
  return Buffer.concat(out);
}

/** 写一个包目录：<outDir>/payload.enc + package.info.json */
export function writePackage({ files, passphrase, outDir, createdAt }) {
  const { bundle, manifest } = buildBundle(files);
  const enc = encryptBundle(bundle, passphrase);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'payload.enc'), enc);
  fs.writeFileSync(
    path.join(outDir, 'package.info.json'),
    JSON.stringify({ createdAt: createdAt || new Date().toISOString(), fileCount: manifest.fileCount, totalBytes: manifest.totalBytes }, null, 2),
    'utf8',
  );
  return { enc: enc.length, manifest };
}
