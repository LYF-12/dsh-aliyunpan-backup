import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PKG_NAME = 'dsh-aliyunpan-backup';

/** 数据目录：<home>/.dsh/dsh-aliyunpan-backup（可用 DSH_AB_HOME 覆盖） */
export function homeDir() {
  if (process.env.DSH_AB_HOME) return process.env.DSH_AB_HOME;
  // 子进程只拿到 DSH_AB_CONFIG 时，从配置文件位置反推数据目录，避免读错 home。
  const cfgPath = process.env.DSH_AB_CONFIG;
  if (cfgPath && path.isAbsolute(cfgPath)) return path.dirname(cfgPath);
  return path.join(os.homedir(), '.dsh', PKG_NAME);
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

/** 历史路径（仅本机存在时命中，用于向后兼容） */
const DEFAULT_CANDIDATES = [
  'D:\\Code\\deepseek\\cs\\.dsh-export\\aliyunpan\\aliyunpan-v0.4.0-windows-x64\\aliyunpan.exe',
  'C:\\Tools\\aliyunpan\\aliyunpan.exe',
];

function toolName() {
  return process.platform === 'win32' ? 'aliyunpan.exe' : 'aliyunpan';
}

/** 与机器无关的候选：插件数据目录、常见安装目录、PATH 每一项。 */
function portableCandidates() {
  const exe = toolName();
  const out = [
    path.join(homeDir(), exe),
    path.join(homeDir(), 'tools', exe),
    path.join(os.homedir(), 'aliyunpan', exe),
  ];
  const local = process.env.LOCALAPPDATA;
  if (local) {
    out.push(path.join(local, 'Programs', 'aliyunpan', exe));
    out.push(path.join(local, 'aliyunpan', exe));
  }
  if (process.platform === 'win32') {
    out.push('C:\\Program Files\\aliyunpan\\' + exe);
    out.push('C:\\Program Files (x86)\\aliyunpan\\' + exe);
  } else {
    out.push('/usr/local/bin/' + exe, '/opt/homebrew/bin/' + exe, '/usr/bin/' + exe);
  }
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    const trimmed = dir.trim().replace(/^"|"$/g, '');
    if (trimmed) out.push(path.join(trimmed, exe));
  }
  return out;
}

export const DEFAULTS = {
  dshHome: path.join(os.homedir(), '.dsh'),
  stagingDir: '',
  aliyunpanExe: '',
  keyFile: '',
  restoreDir: '',
  // ---- 同步（多机共享同一份 DSH 数据；不走加密包，逐目录增量）----
  syncDir: '/DeepSeek Harness/DSH-Sync',
  syncDirs: ['sessions', 'attachments', 'storages', 'task-board'],
  syncMode: 'upload',
  syncMachine: '',
  syncLockMinutes: 60,
  syncDlDir: '',
  syncPrune: false,
};

/** 允许同步的目录白名单：都是「只含数据、不含 node_modules」的目录。 */
export const SYNC_DIR_CHOICES = [
  'sessions',
  'attachments',
  'storages',
  'task-board',
  'skins',
  'pets',
  'eda',
  'sources',
  'backups',
  'dsh-usage',
];

/** 默认同步范围：会话、附件、工作区/定时/缓存索引、任务板。 */
export const SYNC_DIR_DEFAULT = ['sessions', 'attachments', 'storages', 'task-board'];

/** 每个同步根：本地目录 ↔ 云端目录。 */
export function syncRoots(cfg = readConfig()) {
  const base = String(cfg.syncDir || DEFAULTS.syncDir).replace(/\/+$/, '');
  const names = Array.isArray(cfg.syncDirs) && cfg.syncDirs.length ? cfg.syncDirs : SYNC_DIR_DEFAULT;
  return names.map((name) => ({
    name,
    local: path.join(cfg.dshHome, name),
    remote: base + '/' + name,
  }));
}

export function readConfig() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    raw = {};
  }
  const cfg = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  // 同步字段兜底：目录名只认白名单，模式只认 upload/download。
  cfg.syncDirs = Array.isArray(cfg.syncDirs)
    ? cfg.syncDirs.filter((n) => SYNC_DIR_CHOICES.includes(n))
    : SYNC_DIR_DEFAULT.slice();
  if (!cfg.syncDirs.length) cfg.syncDirs = SYNC_DIR_DEFAULT.slice();
  cfg.syncMode = cfg.syncMode === 'download' ? 'download' : 'upload';
  cfg.syncLockMinutes = Number.isFinite(Number(cfg.syncLockMinutes))
    ? Math.max(0, Math.min(1440, Number(cfg.syncLockMinutes)))
    : 60;
  cfg.syncDlDir = typeof cfg.syncDlDir === 'string' ? cfg.syncDlDir.trim() : '';
  cfg.syncPrune = cfg.syncPrune === true;
  return cfg;
}

export function writeConfig(patch) {
  const next = { ...readConfig(), ...(patch && typeof patch === 'object' ? patch : {}) };
  ensureHome();
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

/** aliyunpan 可执行文件：配置优先，其次已知路径，最后 PATH。 */
/** 全部候选路径（含 PATH），导出来便于自测。 */
export function candidatePaths() {
  return DEFAULT_CANDIDATES.concat(portableCandidates());
}

export function resolveExe(cfg = readConfig()) {
  if (cfg.aliyunpanExe && fs.existsSync(cfg.aliyunpanExe)) return cfg.aliyunpanExe;
  for (const p of candidatePaths()) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* 非法 PATH 项忽略 */
    }
  }
  return '';
}

/** 本地暂存目录（解包临时目录 + KEY.txt + 下载的包）。 */
export function stagingDir(cfg = readConfig()) {
  if (cfg.stagingDir) return cfg.stagingDir;
  // 仅在「没有显式数据目录」时才复用旧版固定路径；设了 DSH_AB_HOME 视为隔离/多实例，
  // 绝不能去写别人机器上的 D:\DSH-Backup（否则会串用、甚至覆盖别人的 KEY.txt）。
  const legacy = 'D:\\DSH-Backup';
  if (!process.env.DSH_AB_HOME && fs.existsSync(legacy)) return legacy;
  return path.join(homeDir(), 'staging');
}

/** 同步下载暂存目录（aliyunpan 先下到这里，再由本插件镜像进 .dsh）。 */
export function syncDlDir(cfg = readConfig()) {
  if (cfg.syncDlDir) return cfg.syncDlDir;
  return path.join(homeDir(), 'sync-dl');
}

export function keyFile(cfg = readConfig()) {
  if (cfg.keyFile) return cfg.keyFile;
  return path.join(stagingDir(cfg), 'KEY.txt');
}

/** 环境变量：子进程（restore/syncd）据此拿到同一份配置。 */
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
    aliyunpanExe: resolveExe(cfg),
    restoreDir: cfg.restoreDir,
    syncDir: cfg.syncDir,
    syncDirs: cfg.syncDirs,
    syncMode: cfg.syncMode,
    syncMachine: cfg.syncMachine || os.hostname(),
    syncLockMinutes: cfg.syncLockMinutes,
    syncDlDir: syncDlDir(cfg),
    syncPrune: cfg.syncPrune,
    syncRoots: syncRoots(cfg),
  };
}
