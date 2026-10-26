import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveExe } from '../config.mjs';

// 一条命令：打包加密 → 上传 → 本地校验 → 清理云端旧快照
// 用法: node sync.mjs [--no-feishu-files] [--keep 5] [--no-upload] [--dry-run]
const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n, def) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : def; };

// 配置来源：DSH_AB_CONFIG（插件宿主传入）→ 独立运行时默认值
const CFG = (() => {
  try {
    const p = process.env.DSH_AB_CONFIG;
    if (p && fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  return {};
})();
const LEGACY = 'D:\\DSH-Backup';
const HOME = process.env.DSH_AB_HOME || path.join(os.homedir(), '.dsh', 'dsh-aliyunpan-backup');
const ROOT = CFG.stagingDir || (fs.existsSync(LEGACY) ? LEGACY : path.join(HOME, 'staging'));
const SNAP_ROOT = path.join(ROOT, 'snapshots');
const REMOTE_ROOT = String(CFG.remoteDir || '/DeepSeek Harness/DSH-Backup').replace(/\/+$/, '') + '/snapshots';
const KEEP = Number(opt('keep', String(CFG.keep === undefined ? 5 : CFG.keep)));
// 与宿主同一套发现逻辑：配置 → 历史路径 → 插件目录/常见位置/PATH
const EXE = resolveExe(CFG) || 'aliyunpan';
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const NODE = process.execPath;

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
  const out = (r.stdout || '') + (r.stderr || '');
  return { code: r.status, out };
}

// 1) 打包加密
const buildArgs = [path.join(HERE, 'build.mjs')];
if (flag('no-feishu-files')) buildArgs.push('--no-feishu-files');
console.log('[1/4] build …');
const b = run(NODE, buildArgs);
process.stdout.write(b.out);
if (b.code !== 0) { console.error('build failed'); process.exit(1); }
const m = b.out.match(/snapshot\s*[:=]\s*(\S+)/i) || b.out.match(/snapshots\\(\d{8}T\d{4}-full)/);
let snapId = m ? m[1].replace(/^.*[\\/]/, '') : null;
if (!snapId) {
  const dirs = fs.readdirSync(SNAP_ROOT).filter((d) => /^\d{8}T\d{4}-full$/.test(d)).sort();
  snapId = dirs[dirs.length - 1];
}
if (!snapId) { console.error('cannot determine snapshot id'); process.exit(1); }
const localDir = path.join(SNAP_ROOT, snapId);
const enc = path.join(localDir, 'payload.enc');
const bytes = fs.statSync(enc).size;
console.log('[1/4] snapshot=' + snapId + ' payload=' + (bytes / 1048576).toFixed(2) + ' MB');

// 2) 上传
let uploaded = false;
if (flag('no-upload') || flag('dry-run')) {
  console.log('[2/4] upload skipped');
} else {
  console.log('[2/4] upload …');
  const u = run(EXE, ['upload', localDir, REMOTE_ROOT]);
  const tail = u.out.split(/\r?\n/).filter(Boolean).slice(-4).join('\n');
  console.log(tail);
  uploaded = /上传文件成功/.test(u.out) && /上传结束/.test(u.out);
  if (!uploaded) {
    console.error('[2/4] upload FAILED (exit=' + u.code + '); 本地包保留在 ' + localDir);
    process.exit(2);
  }
  // 远端尺寸核对
  const ls = run(EXE, ['ls', REMOTE_ROOT + '/' + snapId]);
  const sizeLine = (ls.out.match(/payload\.enc/) || []).length ? ls.out : '';
  const okSize = new RegExp((bytes / 1048576).toFixed(2) + 'MB').test(sizeLine);
  console.log('[2/4] remote size check: ' + (okSize ? 'OK' : 'WARN (未能从 ls 中匹配尺寸)'));
}

// 3) 本地校验（解密 + 逐文件 sha256）
console.log('[3/4] verify …');
const v = run(NODE, [path.join(HERE, 'restore.mjs'), '--pkg', localDir, '--verify-only']);
const vtail = v.out.split(/\r?\n/).filter(Boolean).slice(-2).join(' | ');
console.log(vtail);
const verified = /ok=(\d+) bad=0 missing=0/.test(v.out) && v.code === 0;
console.log('[3/4] verify: ' + (verified ? 'PASS' : 'FAIL'));

// 4) 清理云端旧快照（保留最近 KEEP 份，含本次）
if (uploaded && KEEP > 0) {
  const lsAll = run(EXE, ['ls', REMOTE_ROOT]);
  const ids = [...lsAll.out.matchAll(/(\d{8}T\d{4}-full)/g)].map((x) => x[1]);
  const uniq = [...new Set(ids)].sort();
  const old = uniq.slice(0, Math.max(0, uniq.length - KEEP));
  if (old.length) {
    console.log('[4/4] pruning ' + old.length + ' old snapshot(s): ' + old.join(', '));
    if (!flag('dry-run')) {
      const args = ['rm'].concat(old.map((id) => REMOTE_ROOT + '/' + id));
      const p = run('powershell', ['-NoProfile', '-Command', "'y' | & '" + EXE + "' rm " + old.map((id) => "'" + REMOTE_ROOT + '/' + id + "'").join(' ')]);
      console.log((p.out.split(/\r?\n/).filter(Boolean).slice(-3).join('\n')) || '(no output)');
    }
  } else {
    console.log('[4/4] nothing to prune (total=' + uniq.length + ', keep=' + KEEP + ')');
  }
}

console.log('\nRESULT: snapshot=' + snapId + ' bytes=' + bytes + ' uploaded=' + uploaded + ' verified=' + verified);
process.exit(verified ? 0 : 3);
