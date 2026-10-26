import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfig, syncRoots } from './config.mjs';

/** 递归统计一个目录：文件数 + 字节数（跳过符号链接、node_modules、.git）。 */
export function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        stack.push(full);
      } else if (entry.isFile()) {
        files += 1;
        try {
          bytes += fs.statSync(full).size;
        } catch {
          /* 单个文件读不到不影响统计 */
        }
      }
    }
  }
  return { files, bytes };
}

/** 同步计划：每个目录本地有多少文件 / 多大，云端目标在哪。 */
export function planSync(cfg = readConfig()) {
  const roots = syncRoots(cfg).map((root) => {
    const exists = fs.existsSync(root.local);
    const stats = exists ? dirStats(root.local) : { files: 0, bytes: 0 };
    return { ...root, exists, files: stats.files, bytes: stats.bytes };
  });
  return {
    machine: cfg.syncMachine || os.hostname(),
    mode: cfg.syncMode,
    dir: cfg.syncDir,
    roots,
    totalFiles: roots.reduce((sum, root) => sum + root.files, 0),
    totalBytes: roots.reduce((sum, root) => sum + root.bytes, 0),
  };
}
