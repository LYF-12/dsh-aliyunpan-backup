import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// 密钥信封：把 .credentials.yaml 用口令（KEY.txt）加密后单独上传，
// 云端只存在密文，从机用同一口令解回明文。
// 格式（与加密备份包无关，单独一条流）：
//   magic(8) | salt(16) | nonce(12) | ciphertext | tag(16)
//   AES-256-GCM，AAD 固定 'dsh-credentials-v1'，scrypt(N=32768,r=8,p=1) 派生密钥。
export const MAGIC = 'DSHKEY01';
export const ENC_NAME = '.credentials.yaml.enc';
export const CRED_NAME = '.credentials.yaml';
const AAD = 'dsh-credentials-v1';
const HEADER = 8 + 16 + 12;
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 96 * 1048576 };

/** 本机凭据文件路径。 */
export function credentialsPath(dshHome) {
  return path.join(String(dshHome || ''), CRED_NAME);
}

/** 读口令：KEY.txt 的全文 trim 后至少 8 个字符。失败时抛可读中文错误。 */
export function readPass(keyFile) {
  const file = String(keyFile || '').trim();
  if (!file) throw new Error('还没有设置口令文件（KEY.txt），密钥信封需要它');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error('读不到口令文件：' + file + '（换电脑时请粘贴旧机器的口令）');
  }
  const pass = text.trim();
  if (pass.length < 8) throw new Error('口令太短（至少 8 个字符）：' + file);
  return pass;
}

export function hasPass(keyFile) {
  try {
    readPass(keyFile);
    return true;
  } catch {
    return false;
  }
}

/** 加密一团字节。 */
export function seal(plain, pass) {
  const salt = crypto.randomBytes(16);
  const nonce = crypto.randomBytes(12);
  const key = crypto.scryptSync(pass, salt, 32, SCRYPT);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(AAD, 'utf8'));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from(MAGIC, 'latin1'), salt, nonce, body, cipher.getAuthTag()]);
}

/** 解密；口令错/被改过都抛同一个可读错误。 */
export function open(buf, pass) {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (data.length <= HEADER + 16) throw new Error('信封太短，可能不是密钥信封文件');
  if (data.subarray(0, 8).toString('latin1') !== MAGIC) throw new Error('不是密钥信封（magic 不匹配）：' + data.subarray(0, 8).toString('latin1'));
  const salt = data.subarray(8, 24);
  const nonce = data.subarray(24, 36);
  const tag = data.subarray(data.length - 16);
  const body = data.subarray(HEADER, data.length - 16);
  const key = crypto.scryptSync(pass, salt, 32, SCRYPT);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(AAD, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new Error('口令不对（或信封被改过），解密失败');
  }
}

/** 读本机凭据并加密，返回信封字节；本机没有凭据时抛错。 */
export function sealFile(dshHome, keyFile) {
  const src = credentialsPath(dshHome);
  let plain;
  try {
    plain = fs.readFileSync(src);
  } catch {
    throw new Error('本机没有 ' + src + '，不需要同步凭据');
  }
  return seal(plain, readPass(keyFile));
}

/**
 * 解出明文并写回本机。已有内容不同则先备份成 .credentials.yaml.bak-<时间戳>。
 * 返回 { changed, backup, bytes }。
 */
export function openToFile(buf, keyFile, destFile) {
  const plain = open(buf, readPass(keyFile));
  const dest = String(destFile);
  let same = false;
  try {
    same = Buffer.compare(fs.readFileSync(dest), plain) === 0;
  } catch {
    same = false;
  }
  if (same) return { changed: false, backup: '', bytes: plain.length };
  let backup = '';
  if (fs.existsSync(dest)) {
    backup = dest + '.bak-' + new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
    try {
      fs.copyFileSync(dest, backup);
    } catch {
      backup = '';
    }
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, plain, { mode: 0o600 });
  return { changed: true, backup, bytes: plain.length };
}