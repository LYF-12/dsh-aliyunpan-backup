import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { homeDir, readConfig, resolveExe, syncRoots } from '../config.mjs';
import { planSync } from '../syncplan.mjs';

// 逐目录镜像同步：一台机器只跑一个方向（主机 upload / 从机 download）。
// 用法: node syncd.mjs --mode upload|download|plan [--strict] [--prune] [--lock-minutes 60]
//
// 为什么不用 aliyunpan 自带的 `sync start`：它的任务状态按「云盘目录 basename」派生，
// 同一台机器先上传后下载同名目录会互相污染（认为已同步而跳过，甚至永久挂住）。
// 这里改用 `upload` / `download` 两个确定性命令，增量判断与镜像由本脚本负责。
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const MODE = opt('mode', 'upload');
const STRICT = argv.includes('--strict');

// readConfig() 自带默认值兜底（dshHome / syncDir / 白名单归一），
// 子进程只拿到 DSH_AB_CONFIG 时 homeDir() 会从配置文件位置反推出数据目录。
const CFG = readConfig();

const EXE = resolveExe(CFG);
const HOME = homeDir();
const MACHINE = CFG.syncMachine || os.hostname();
const SYNC_DIR = String(CFG.syncDir || '/DeepSeek Harness/DSH-Sync').replace(/\/+$/, '');
const LOCK_MINUTES = Number(opt('lock-minutes', CFG.syncLockMinutes === undefined ? 60 : CFG.syncLockMinutes));
const PRUNE = argv.includes('--prune') || CFG.syncPrune === true;
const FORCE = argv.includes('--force');
const ROOTS = syncRoots({ ...CFG, syncMachine: MACHINE });

function mb(bytes) {
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function run(args, timeoutMs = 60 * 60 * 1000) {
  const result = spawnSync(EXE, args, { encoding: 'utf8', maxBuffer: 1 << 28, timeout: timeoutMs });
  return { code: result.status, out: (result.stdout || '') + (result.stderr || '') };
}

function plan() {
  const p = planSync({ ...CFG, syncDirs: ROOTS.filter((root) => root.kind !== 'file').map((root) => root.name) });
  console.log('同步方向: ' + (MODE === 'download' ? '云盘 → 本机（从机拉取）' : '本机 → 云盘（主机上传）'));
  console.log('云端目录: ' + SYNC_DIR);
  console.log('机器标识: ' + MACHINE);
  console.log('');
  for (const root of p.roots) {
    console.log(
      '  ' + root.name.padEnd(14) + (root.exists ? String(root.files).padStart(6) : '     -') + ' files  ' +
        (root.exists ? mb(root.bytes).padStart(9) : '        -') + '  → ' + root.remote,
    );
  }
  console.log('');
  console.log('SYNC RESULT: mode=plan roots=' + p.roots.length + ' files=' + p.totalFiles + ' bytes=' + p.totalBytes + ' failed=0');
  return 0;
}

/** 云端最近是否有别的机器同步过（_last-sync-<machine>.json 的修改时间）。 */
function otherMachineActivity() {
  if (!EXE || LOCK_MINUTES <= 0) return [];
  const listing = run(['ls', SYNC_DIR], 60000);
  const out = listing.out || '';
  const hits = [];
  const pattern = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+(_last-sync-.+?\.json)/g;
  let match = pattern.exec(out);
  while (match) {
    const stamp = match[1].replace(' ', 'T');
    const ageMinutes = (Date.now() - new Date(stamp).getTime()) / 60000;
    if (match[2] !== '_last-sync-' + MACHINE + '.json' && ageMinutes >= 0 && ageMinutes <= LOCK_MINUTES) {
      hits.push({ file: match[2], minutes: Math.round(ageMinutes) });
    }
    match = pattern.exec(out);
  }
  return hits;
}

/** 同步完成后在云端留一个「我刚同步过」的标记，另一台机器据此判断是否该等。 */
function markActivity(summary) {
  if (!EXE) return;
  const file = path.join(HOME, '_last-sync-' + MACHINE.replace(/[\\/:*?"<>|]/g, '_') + '.json');
  try {
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(summary, null, 2) + '\n', 'utf8');
    const up = run(['upload', '-ow', file, SYNC_DIR], 120000);
    if (up.code !== 0) console.log('[warn] 同步标记上传失败: ' + up.out.split(/\r?\n/).filter(Boolean).slice(-2).join(' | '));
  } catch (error) {
    console.log('[warn] 写同步标记失败: ' + String((error && error.message) || error));
  }
}

const DENIED = /Access is denied|拒绝访问/i;

/** 下载暂存目录：配置优先；否则用插件数据目录，失败再退到系统临时目录 / 用户目录。 */
function dlCandidates() {
  const explicit = String(CFG.syncDlDir || '').trim();
  if (explicit) return [path.resolve(explicit)];
  const out = [path.join(HOME, 'sync-dl'), path.join(os.tmpdir(), 'dsh-aliyunpan-sync')];
  if (process.env.USERPROFILE) out.push(path.join(process.env.USERPROFILE, 'dsh-aliyunpan-sync'));
  return [...new Set(out)];
}

function relParts(remote) {
  return String(remote).replace(/^\/+/, '').split('/').filter(Boolean);
}

function walk(dir, rel, visitFile) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const abs = path.join(dir, entry.name);
    const next = rel ? rel + '/' + entry.name : entry.name;
    if (entry.isDirectory()) walk(abs, next, visitFile);
    else if (entry.isFile()) visitFile(next, abs);
  }
}

/** 把暂存目录里刚下载的内容镜像到本地目标目录（size+mtime 相同就跳过）。 */
function mirror(srcRoot, dstRoot, prune) {
  const seen = new Set();
  let copied = 0;
  let same = 0;
  walk(srcRoot, '', (rel, abs) => {
    seen.add(rel);
    const dst = path.join(dstRoot, ...rel.split('/'));
    let need = true;
    try {
      const s = fs.statSync(abs);
      const d = fs.statSync(dst);
      if (s.size === d.size && Math.floor(s.mtimeMs / 1000) <= Math.floor(d.mtimeMs / 1000)) need = false;
    } catch {
      need = true;
    }
    if (!need) {
      same += 1;
      return;
    }
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(abs, dst);
      try {
        const s = fs.statSync(abs);
        fs.utimesSync(dst, s.atime, s.mtime);
      } catch {
        /* 时间戳写不进去不影响内容 */
      }
      copied += 1;
    } catch (error) {
      console.log('[fail] 写入本地失败: ' + dst + ' — ' + String((error && error.message) || error));
    }
  });
  let pruned = 0;
  if (prune) {
    const extra = [];
    walk(dstRoot, '', (rel) => {
      if (!seen.has(rel)) extra.push(rel);
    });
    for (const rel of extra) {
      try {
        fs.unlinkSync(path.join(dstRoot, ...rel.split('/')));
        pruned += 1;
      } catch {
        /* 删不掉就留着 */
      }
    }
  }
  return { copied, same, pruned };
}

function printOut(out) {
  for (const line of String(out || '').split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    if (/^-+$/.test(text)) continue;
    console.log(text);
  }
}

/** 云端某个目录下有多少文件 / 多大（tree 命令的最后一行）。 */
function treeCount(remote) {
  const result = run(['tree', remote], 300000);
  const match = /(\d+)\s*个文件夹,\s*(\d+)\s*个文件,\s*([\d.]+)\s*(B|KB|MB|GB)\s*总大小/.exec(result.out || '');
  if (!match) return null;
  const scale = { B: 1, KB: 1024, MB: 1048576, GB: 1073741824 }[match[4]] || 1;
  return { files: Number(match[2]), bytes: Math.round(Number(match[3]) * scale) };
}

const INDEX_PATH = path.join(HOME, 'sync-index.json');

function loadIndex() {
  try {
    const raw = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function saveIndex(index) {
  try {
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(INDEX_PATH, JSON.stringify(index) + '\n', 'utf8');
  } catch (error) {
    console.log('[warn] 索引写入失败: ' + String((error && error.message) || error));
  }
}

function fileSig(abs) {
  const st = fs.statSync(abs);
  return { size: st.size, mtime: Math.floor(st.mtimeMs / 1000) };
}

/** 云端文件所在目录（用于 upload 的最后一个参数）。 */
function remoteParent(remote) {
  const text = String(remote).replace(/\/+$/, '');
  const at = text.lastIndexOf('/');
  return at > 0 ? text.slice(0, at) : text;
}

/** 单文件上传：装配文件很小，永远 -ow 覆盖，不产生 name(1).ext。 */
function uploadFile(root) {
  const started = Date.now();
  if (!fs.existsSync(root.local)) {
    console.log('[skip] ' + root.name + '：本机没有这个文件（' + root.local + '）');
    return { name: root.name, ok: true, skipped: true, files: 0 };
  }
  const index = loadIndex();
  const before = index[root.name] && typeof index[root.name] === 'object' ? index[root.name] : {};
  let sig;
  try {
    sig = fileSig(root.local);
  } catch {
    return { name: root.name, ok: false, files: 0 };
  }
  const prev = before.file;
  if (!FORCE && prev && prev.size === sig.size && prev.mtime === sig.mtime) {
    console.log('--- ' + root.name + '：无变化，跳过');
    return { name: root.name, ok: true, files: 0, unchanged: true, seconds: 0 };
  }
  console.log('');
  console.log('=== ' + root.name + '  ' + root.local + ' → ' + root.remote);
  const result = run(['upload', '-ow', '-p', '1', root.local, remoteParent(root.remote)]);
  printOut(result.out);
  const ok = result.code === 0 && !/上传失败|未登录|请先登录|Access is denied/.test(result.out || '');
  if (ok) {
    index[root.name] = { file: sig };
    saveIndex(index);
  }
  console.log('--- ' + root.name + '：' + (ok ? 'OK' : 'FAILED') + ' 上传 ' + (ok ? 1 : 0) + ' 个文件 用时 ' + Math.round((Date.now() - started) / 1000) + 's');
  return { name: root.name, ok, files: ok ? 1 : 0 };
}

/** 单文件下载：先下到暂存目录，再按 size+mtime 决定要不要覆盖本地。 */
function downloadFile(root) {
  console.log('');
  console.log('=== ' + root.name + '  ' + root.remote + ' → ' + root.local);
  const started = Date.now();
  let last = { code: -1, out: '' };
  let dlDir = '';
  for (const candidate of dlCandidates()) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
    } catch {
      /* 建不出来让它自己报 */
    }
    dlDir = candidate;
    last = run(['download', '--saveto', candidate, '--ow', '-p', '1', root.remote]);
    if (DENIED.test(last.out || '')) {
      printOut(last.out);
      console.log('[retry] ' + candidate + ' 写不了，换下一个暂存目录');
      continue;
    }
    break;
  }
  const src = path.join(dlDir, ...relParts(root.remote));
  if (!fs.existsSync(src)) {
    console.log('--- ' + root.name + '：云端没有这个文件，跳过');
    return { name: root.name, ok: true, files: 0, empty: true, seconds: Math.round((Date.now() - started) / 1000) };
  }
  let need = true;
  try {
    const s = fs.statSync(src);
    const d = fs.statSync(root.local);
    if (s.size === d.size && Math.floor(s.mtimeMs / 1000) <= Math.floor(d.mtimeMs / 1000)) need = false;
  } catch {
    need = true;
  }
  let copied = 0;
  if (need) {
    try {
      fs.mkdirSync(path.dirname(root.local), { recursive: true });
      fs.copyFileSync(src, root.local);
      try {
        const s = fs.statSync(src);
        fs.utimesSync(root.local, s.atime, s.mtime);
      } catch {
        /* 时间戳写不进去不影响内容 */
      }
      copied = 1;
    } catch (error) {
      console.log('[fail] 写入本地失败: ' + root.local + ' — ' + String((error && error.message) || error));
      return { name: root.name, ok: false, files: 0 };
    }
  }
  try {
    fs.rmSync(src, { force: true });
  } catch {
    /* 暂存文件删不掉不影响结果 */
  }
  console.log('--- ' + root.name + '：OK 下载 ' + (copied ? 1 : 0) + ' 更新 ' + copied + ' 未变 ' + (copied ? 0 : 1) + ' 用时 ' + Math.round((Date.now() - started) / 1000) + 's');
  return { name: root.name, ok: true, files: copied, downloaded: copied ? 1 : 0, same: copied ? 0 : 1, seconds: Math.round((Date.now() - started) / 1000) };
}

function listFiles(dir) {
  const out = [];
  walk(dir, '', (rel, abs) => out.push({ rel, abs }));
  return out;
}

/**
 * 上传一个根目录。
 * aliyunpan 的 upload 没有「只传变化」的能力：默认同名会生成 name(1).ext，
 * 加 -ow 会把旧文件丢进回收站（未变化的文件也会被反复覆盖）。
 * 所以用本地索引（rel → size+mtime）算出新增/修改，分别用 --skip 和 -ow 精确上传。
 */
function uploadOne(root) {
  if (root.kind === 'file') return uploadFile(root);
  if (!fs.existsSync(root.local)) {
    console.log('[skip] ' + root.name + '：本机没有这个目录（' + root.local + '）');
    return { name: root.name, ok: true, skipped: true, files: 0 };
  }
  console.log('');
  console.log('=== ' + root.name + '  ' + root.local + ' → ' + root.remote);
  const started = Date.now();
  const index = loadIndex();
  const before = index[root.name] && typeof index[root.name] === 'object' ? index[root.name] : {};
  const files = listFiles(root.local);
  const changed = [];
  for (const file of files) {
    let sig;
    try {
      sig = fileSig(file.abs);
    } catch {
      continue;
    }
    const prev = before[file.rel];
    if (FORCE || !prev || prev.size !== sig.size || prev.mtime !== sig.mtime) changed.push({ ...file, sig });
  }
  if (!files.length) {
    console.log('--- ' + root.name + '：本地是空目录，跳过');
    return { name: root.name, ok: true, files: 0, empty: true };
  }
  if (!changed.length) {
    console.log('--- ' + root.name + '：无变化（' + files.length + ' 个文件都与上次一致），跳过');
    return { name: root.name, ok: true, files: 0, unchanged: true, seconds: Math.round((Date.now() - started) / 1000) };
  }
  // 本机没有该目录的同步索引（首次同步 / 索引被删）时，--skip 会按文件名跳过云端已有文件，
  // 那样内容就永远停在旧版本。这种情况一律走 -ow 全量覆盖，宁可多传一次。
  const firstRun = Object.keys(before).length === 0;
  const added = firstRun ? [] : changed.filter((file) => !before[file.rel]);
  const modified = firstRun ? changed : changed.filter((file) => before[file.rel]);
  console.log(
    '[plan] ' + (firstRun ? '无同步索引，全量覆盖 ' : '新增 ' + added.length + ' / 修改 ') +
      (firstRun ? changed.length : modified.length) + ' / 合计 ' + files.length + ' 个文件',
  );

  let ok = true;
  let logs = '';
  // 逐文件上传（只传变化的），按云端父目录分组：
  //   新增 → --skip（同名跳过，不会产生 name(1).ext 副本）
  //   修改 → -ow（旧版本进回收站）
  const groupOf = (file) => {
    const parts = file.rel.split('/');
    parts.pop();
    const dirRel = parts.join('/');
    return (root.remote + (dirRel ? '/' + dirRel : '')).replace(/\/+$/, '');
  };
  for (const batch of [{ files: added, flags: ['--skip'] }, { files: modified, flags: ['-ow'] }]) {
    const groups = new Map();
    for (const file of batch.files) {
      const remoteParent = groupOf(file);
      if (!groups.has(remoteParent)) groups.set(remoteParent, []);
      groups.get(remoteParent).push(file.abs);
    }
    for (const [remoteParent, absList] of groups) {
      // 一次命令行最多带 20 个源文件，避免命令过长
      for (let i = 0; i < absList.length; i += 20) {
        const chunk = absList.slice(i, i + 20);
        const result = run(['upload', ...batch.flags, '-p', '4', ...chunk, remoteParent]);
        logs += result.out;
        if (result.code !== 0) ok = false;
      }
    }
  }
  printOut(logs);
  const failed = /以下文件上传失败|上传失败|Access is denied|未登录|请先登录/.test(logs);
  if (failed) ok = false;
  const done = (logs.match(/文件上传结果：\s*成功/g) || []).length;
  if (done === 0 && ok) ok = false;

  if (ok) {
    const next = { ...before };
    for (const file of changed) next[file.rel] = file.sig;
    index[root.name] = next;
    if (PRUNE) {
      const alive = new Set(files.map((file) => file.rel));
      let prunedRemote = 0;
      for (const rel of Object.keys(before)) {
        if (alive.has(rel)) continue;
        const remote = (root.remote + '/' + rel).replace(/\/+$/, '');
        const del = run(['rm', remote], 120000);
        if (del.code === 0) prunedRemote += 1;
        delete next[rel];
      }
      if (prunedRemote) console.log('--- 云端删除 ' + prunedRemote + ' 个本机已不存在的文件');
    }
    saveIndex(index);
  }
  const cloud = treeCount(root.remote);
  const seconds = Math.round((Date.now() - started) / 1000);
  if (cloud) console.log('--- 云端现有 ' + cloud.files + ' files / ' + mb(cloud.bytes));
  console.log('--- ' + root.name + '：' + (ok ? 'OK' : 'FAILED') + ' 上传 ' + done + ' 个文件 用时 ' + seconds + 's');
  return { name: root.name, ok, files: done, uploaded: done, code: 0, seconds };
}
function downloadOne(root) {
  if (root.kind === 'file') return downloadFile(root);
  try {
    fs.mkdirSync(root.local, { recursive: true });
  } catch (error) {
    console.log('[fail] ' + root.name + '：无法创建本地目录 ' + String((error && error.message) || error));
    return { name: root.name, ok: false, files: 0 };
  }
  console.log('');
  console.log('=== ' + root.name + '  ' + root.remote + ' → ' + root.local);
  const started = Date.now();
  const denied = [];
  let last = { code: -1, out: '' };
  let dlDir = '';
  for (const candidate of dlCandidates()) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
    } catch {
      /* 建不出来让它自己报 */
    }
    dlDir = candidate;
    console.log('[staging] ' + candidate);
    last = run(['download', '--saveto', candidate, '--ow', '-p', '3', root.remote]);
    if (DENIED.test(last.out || '')) {
      printOut(last.out);
      denied.push(candidate);
      console.log('[retry] ' + candidate + ' 写不了，换下一个暂存目录');
      continue;
    }
    break;
  }
  const out = last.out || '';
  if (denied.length && DENIED.test(out)) {
    console.log('[fail] aliyunpan 无法写入任何暂存目录：' + denied.join(' / '));
    console.log('[hint] 本机安全软件限制了 aliyunpan.exe 的写盘位置。请在配置里把「下载暂存目录」改到它允许的目录（例如你的开发目录），或给 aliyunpan.exe 加信任/例外。');
    return { name: root.name, ok: false, files: 0, denied: true, code: last.code };
  }
  const staging = path.join(dlDir, ...relParts(root.remote));
  if (!fs.existsSync(staging)) {
    console.log('--- ' + root.name + '：云端还没有这个目录，跳过');
    return { name: root.name, ok: true, files: 0, empty: true, seconds: Math.round((Date.now() - started) / 1000) };
  }
  const downloaded = (out.match(/下载完成, 保存位置/g) || []).length;
  const result = mirror(staging, root.local, PRUNE);
  try {
    fs.rmSync(staging, { recursive: true, force: true });
  } catch {
    /* 暂存目录删不掉不影响结果 */
  }
  const ok = last.code === 0 || downloaded > 0;
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log('--- ' + root.name + '：' + (ok ? 'OK' : 'FAILED') + ' 下载 ' + downloaded + ' 更新 ' + result.copied + ' 未变 ' + result.same + (PRUNE ? ' 删除 ' + result.pruned : '') + ' 用时 ' + seconds + 's');
  return { name: root.name, ok, files: result.copied, downloaded, same: result.same, pruned: result.pruned, code: last.code, seconds };
}

function main() {
  if (MODE === 'plan') return plan();
  if (MODE !== 'upload' && MODE !== 'download') {
    console.error('未知模式: ' + MODE);
    return 2;
  }
  if (!EXE) {
    console.error('找不到 aliyunpan 可执行文件：请在配置页填写路径，或把它放到 PATH / 插件数据目录。');
    return 2;
  }

  const others = otherMachineActivity();
  if (others.length) {
    const text = others.map((hit) => hit.file + '（' + hit.minutes + ' 分钟前）').join('、');
    console.log('[warn] 云端 ' + LOCK_MINUTES + ' 分钟内有其它机器同步过：' + text);
    console.log('[warn] 按约定同一时间只应有一台机器同步；确认对方已结束后可继续。');
    if (STRICT) {
      console.error('检测到其它机器活动，已按 --strict 退出。');
      return 3;
    }
  }

  const results = [];
  for (const root of ROOTS) results.push(MODE === 'download' ? downloadOne(root) : uploadOne(root));
  const failed = results.filter((item) => !item.ok).length;
  const files = results.reduce((sum, item) => sum + (item.files || 0), 0);
  const summary = {
    at: new Date().toISOString(),
    machine: MACHINE,
    mode: MODE,
    dir: SYNC_DIR,
    prune: PRUNE,
    results,
    files,
    failed,
  };
  try {
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(path.join(HOME, 'sync-state.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  } catch {
    /* 状态文件写不了不影响同步结果 */
  }
  markActivity(summary);
  console.log('');
  console.log('SYNC RESULT: mode=' + MODE + ' roots=' + ROOTS.length + ' files=' + files + ' failed=' + failed);
  if (failed === 0) return 0;
  return results.some((item) => item.denied) ? 5 : 4;
}

process.exitCode = main();