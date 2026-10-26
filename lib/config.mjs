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
  remoteDir: '/DeepSeek Harness/DSH-Backup',
  aliyunpanExe: '',
  keep: 3,
  includeFeishuFiles: false,
  includeCredentials: false,
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

/** 本地暂存目录（快照 + KEY.txt）。 */
export function stagingDir(cfg = readConfig()) {
  if (cfg.stagingDir) return cfg.stagingDir;
  // 仅在「没有显式数据目录」时才复用旧版固定路径；设了 DSH_AB_HOME 视为隔离/多实例，
  // 绝不能去写别人机器上的 D:\DSH-Backup（否则会串用、甚至覆盖别人的 KEY.txt）。
  const legacy = 'D:\\DSH-Backup';
  if (!process.env.DSH_AB_HOME && fs.existsSync(legacy)) return legacy;
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
