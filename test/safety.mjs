import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 隔离沙箱：用临时 DSH_AB_HOME，绝不碰真实 ~/.dsh 和真实回收站。
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ab-safety-'));
process.env.DSH_AB_HOME = ROOT;
process.env.DSH_AB_CONFIG = path.join(ROOT, 'config.json');
process.env.DSH_AB_SYNCD_IMPORT = '1';

const mod = await import('../lib/scripts/syncd.mjs');
const mirror = mod.mirror;

const stamp = Date.now() / 1000;
const fresh = (name) => fs.mkdtempSync(path.join(ROOT, name + '-'));
function write(file, text, mtime) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mtime) fs.utimesSync(file, mtime, mtime);
}
function walkFiles(dir, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}
const ok = [];

// 1) 本机文件更大（本机记录更完整）→ 必须保留本机，云端旧版进回收站
{
  const src = fresh('src1');
  const dst = fresh('dst1');
  write(path.join(src, 'sessions/a.jsonl'), 'CLOUD-OLD', stamp - 600);
  const localText = 'LOCAL-NEWER-' + 'x'.repeat(200);
  write(path.join(dst, 'sessions/a.jsonl'), localText, stamp);
  const r = mirror(src, dst, false, { rootName: 'sessions' });
  assert.equal(r.copied, 0, 'case1 copied');
  assert.equal(r.conflicts, 1, 'case1 conflicts');
  assert.equal(fs.readFileSync(path.join(dst, 'sessions/a.jsonl'), 'utf8'), localText, 'case1 local intact');
  const trash = walkFiles(path.join(ROOT, 'trash'), []).map((p) => p.split(path.sep).join('/'));
  assert.ok(trash.some((p) => p.includes('incoming-sessions')), 'case1 cloud copy stashed');
  ok.push('本机更大时保留本机记录');
}

// 2) 云端文件更大（云端更完整）→ 正常覆盖
{
  const src = fresh('src2');
  const dst = fresh('dst2');
  const cloudText = 'CLOUD-' + 'y'.repeat(300);
  write(path.join(src, 'sessions/b.jsonl'), cloudText, stamp);
  write(path.join(dst, 'sessions/b.jsonl'), 'LOCAL-SHORT', stamp - 600);
  const r = mirror(src, dst, false, { rootName: 'sessions' });
  assert.equal(r.copied, 1, 'case2 copied');
  assert.equal(r.conflicts, 0, 'case2 no conflicts');
  assert.equal(fs.readFileSync(path.join(dst, 'sessions/b.jsonl'), 'utf8'), cloudText, 'case2 overwritten');
  ok.push('云端更完整时正常更新');
}

// 3) storages/workspace.json 必须合并，不能覆盖（覆盖会让本机会话从界面消失）
{
  const src = fresh('src3');
  const dst = fresh('dst3');
  const cloud = { tables: { workspaces: { w1: { path: 'C:/cloud', sessionIds: ['s2', 's3'] }, w9: { path: 'C:/new', sessionIds: ['s7'] } } }, pinnedSessionIds: ['s3'] };
  const local = { tables: { workspaces: { w1: { path: 'D:/local', sessionIds: ['s1', 's2'] } } }, pinnedSessionIds: ['s1'] };
  write(path.join(src, 'workspace.json'), JSON.stringify(cloud), stamp);
  write(path.join(dst, 'workspace.json'), JSON.stringify(local), stamp - 600);
  const r = mirror(src, dst, false, { rootName: 'storages' });
  const merged = JSON.parse(fs.readFileSync(path.join(dst, 'workspace.json'), 'utf8'));
  const ids = merged.tables.workspaces.w1.sessionIds.slice().sort();
  assert.deepEqual(ids, ['s1', 's2', 's3'], 'case3 session id union');
  assert.equal(merged.tables.workspaces.w1.path, 'D:/local', 'case3 local path wins');
  assert.ok(merged.tables.workspaces.w9, 'case3 cloud workspace added');
  assert.deepEqual(merged.pinnedSessionIds.slice().sort(), ['s1', 's3'], 'case3 pins union');
  const bak = walkFiles(dst, []).filter((p) => p.includes('workspace.json.bak-'));
  assert.ok(bak.length === 1, 'case3 backup written');
  assert.equal(r.conflicts, 0, 'case3 not counted as conflict');
  ok.push('工作区索引合并（本机会话不丢）');
}

// 4) 严格镜像但云端这次什么都没取到 → 一个本机文件都不许动
{
  const src = fresh('src4');
  const dst = fresh('dst4');
  write(path.join(dst, 'sessions/keep.jsonl'), 'LOCAL-ONLY', stamp);
  const r = mirror(src, dst, true, { rootName: 'sessions' });
  assert.equal(r.pruned, 0, 'case4 pruned');
  assert.ok(fs.existsSync(path.join(dst, 'sessions/keep.jsonl')), 'case4 local kept');
  ok.push('云端为空时禁止严格镜像删除');
}

// 5) 严格镜像真删多余文件 → 只挪进回收站，可找回
{
  const src = fresh('src5');
  const dst = fresh('dst5');
  write(path.join(src, 'sessions/one.jsonl'), 'BOTH', stamp);
  write(path.join(dst, 'sessions/one.jsonl'), 'BOTH', stamp);
  write(path.join(dst, 'sessions/extra.jsonl'), 'LOCAL-EXTRA', stamp);
  const r = mirror(src, dst, true, { rootName: 'sessions' });
  assert.equal(r.pruned, 1, 'case5 pruned');
  assert.ok(!fs.existsSync(path.join(dst, 'sessions/extra.jsonl')), 'case5 removed from local');
  const trash = walkFiles(path.join(ROOT, 'trash'), []).map((p) => p.split(path.sep).join('/'));
  assert.ok(trash.some((p) => p.includes('pruned-sessions/sessions/extra.jsonl')), 'case5 recoverable in trash');
  ok.push('严格镜像删除改成进回收站');
}

// 6) 会话归属缓存 session_projcache 属于本机，云端不覆盖已有文件
{
  const src = fresh('src6');
  const dst = fresh('dst6');
  write(path.join(src, 'session_projcache/c1.json'), 'CLOUD', stamp);
  write(path.join(dst, 'session_projcache/c1.json'), 'LOCAL', stamp - 600);
  const r = mirror(src, dst, false, { rootName: 'storages' });
  assert.equal(r.skipped, 1, 'case6 skipped');
  assert.equal(fs.readFileSync(path.join(dst, 'session_projcache/c1.json'), 'utf8'), 'LOCAL', 'case6 local kept');
  ok.push('会话归属缓存不被云端覆盖');
}

console.log('SAFETY OK  ' + ok.length + '/6  ' + ok.join(' | '));
fs.rmSync(ROOT, { recursive: true, force: true });