import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PKG_NAME = 'dsh-aliyunpan-backup';

/** 数据目录：<home>/.dsh/dsh-aliyunpan-backup（可用 DSH_AB_HOME 覆盖） */
export function homeDir() {
  return process.env.DSH_AB_HOME || path.join(os.homedir(), '.dsh', PKG_NAME);
}
export function configPath() {
  return path.join(homeDir(), 'config.json');
}
export function statePath() {
  return path.join(homeDir(), 'state.json');
}
export function ensureHome() {
  fs.mkdirSync(homeDir(), { recursive: true });
  return homeDir();
}

const DEFAULT_CANDIDATES = [
  'D:\\Code\\deepseek\\cs\\.dsh-export\\aliyunpan\\aliyunpan-v0.4.0-windows-x64\\aliyunpan.exe',
  'C:\\Tools\\aliyunpan\\aliyunpan.exe',
];

export const DEFAULTS = {
  dshHome: path.join(os.homedir(), '.dsh'),
  stagingDir: '',
  remoteDir: '/DeepSeek Harness/DSH-Backup',
  aliyunpanExe: '',
  keep: 3,
  includeFeishuFiles: false,
  keyFile: '',
  restoreDir: '',
};

export function readConfig() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    raw = {};
  }
  const cfg = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  cfg.keep = Number.isFinite(Number(cfg.keep)) ? Math.max(0, Math.min(50, Number(cfg.keep))) : 3;
  cfg.includeFeishuFiles = cfg.includeFeishuFiles === true;
  return cfg;
}

export function writeConfig(patch) {
  const next = { ...readConfig(), ...(patch && typeof patch === 'object' ? patch : {}) };
  ensureHome();
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

/** aliyunpan 可执行文件：配置优先，其次已知路径，最后 PATH。 */
export function resolveExe(cfg = readConfig()) {
  if (cfg.aliyunpanExe && fs.existsSync(cfg.aliyunpanExe)) return cfg.aliyunpanExe;
  for (const p of DEFAULT_CANDIDATES) if (fs.existsSync(p)) return p;
  return '';
}

/** 本地暂存目录（快照 + KEY.txt）。 */
export function stagingDir(cfg = readConfig()) {
  if (cfg.stagingDir) return cfg.stagingDir;
  const legacy = 'D:\\DSH-Backup';
  if (fs.existsSync(legacy)) return legacy;
  return path.join(homeDir(), 'staging');
}

export function keyFile(cfg = readConfig()) {
  if (cfg.keyFile) return cfg.keyFile;
  return path.join(stagingDir(cfg), 'KEY.txt');
}

/** 环境变量：子进程（build/restore/sync）据此拿到同一份配置。 */
export function childEnv() {
  return { ...process.env, DSH_AB_CONFIG: configPath(), DSH_AB_HOME: homeDir() };
}

/** 读取脚本真正使用的运行时参数（供 UI 展示）。 */
export function runtimeView() {
  const cfg = readConfig();
  return {
    configPath: configPath(),
    home: homeDir(),
    dshHome: cfg.dshHome,
    stagingDir: stagingDir(cfg),
    keyFile: keyFile(cfg),
    remoteDir: cfg.remoteDir,
    remoteSnapshots: cfg.remoteDir.replace(/\/+$/, '') + '/snapshots',
    aliyunpanExe: resolveExe(cfg),
    keep: cfg.keep,
    includeFeishuFiles: cfg.includeFeishuFiles,
  };
}
