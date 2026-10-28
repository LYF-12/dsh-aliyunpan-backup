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

export function toolName() {
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
  // 配置文件级同步项（模型装配 / 插件清单 / 凭据），见 SYNC_FILE_CHOICES
  syncFiles: ['model', 'plugins'],
  // 装配文件用的 profile 名；留空 = 本机第一个 profile，本机还没有 profile 时用 desktop
  syncProfile: '',
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

/**
 * 文件级同步项：不进整棵 profiles（那里有 node_modules，几十万文件），
 * 只挑「换台机器能重建环境」的那几个装配文件。
 */
export const SYNC_FILE_CHOICES = [
  {
    id: 'model',
    label: '模型与插件装配（cordis.patch.yml）',
    scope: 'profile',
    files: ['cordis.patch.yml'],
    note: '模型 provider / 模型列表 / 插件插入点。里面不含 API Key（Key 在 .credentials.yaml）。',
  },
  {
    id: 'plugins',
    label: '插件清单（package.json + 锁文件）',
    scope: 'profile',
    files: ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'],
    note: '另一台机器照着这份清单重装插件，node_modules 不传。',
  },
  {
    id: 'credentials',
    label: '登录凭据 .credentials.yaml（含 API Key，明文）',
    scope: 'root',
    files: ['.credentials.yaml'],
    note: '默认不勾。勾了会把 Key 明文传到云盘，只建议私有盘 + 自己的账号。',
  },
];

/** 默认往云盘带的装配文件：模型配置 + 插件清单（都不含密钥）。 */
export const SYNC_FILE_DEFAULT = ['model', 'plugins'];

/** 本机 profile 目录名（跳过 _bak / .cache 之类）。 */
export function profileNames(cfg = readConfig()) {
  const dir = path.join(cfg.dshHome, 'profiles');
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}

/**
 * 装配文件用哪些 profile：优先本机真实存在的（跳过 _bak-*），
 * 本机一个都没有时退回 syncProfile / desktop——否则全新机器还没装 DSH 就拉不到装配文件。
 */
export function profileList(cfg = readConfig()) {
  const local = profileNames(cfg);
  if (local.length) return local;
  const fallback = String(cfg.syncProfile || '').trim();
  return [fallback || 'desktop'];
}

/**
 * 云端 profile 名 → 本机 profile 名：下载时用，不强制两台机器同名。
 * 只有「云端只有一个 profile、本机也只有一个」时才改名落地，否则多个云端 profile
 * 会互相覆盖同一个本地文件，所以宁可各建各的目录。
 */
export function mapProfileName(remoteName, localProfiles, remoteCount = 1) {
  if (localProfiles.includes(remoteName)) return { local: remoteName, note: '' };
  if (!localProfiles.length) return { local: remoteName, note: '' };
  if (remoteCount === 1 && localProfiles.length === 1) {
    return {
      local: localProfiles[0],
      note: '云端 profiles/' + remoteName + ' → 本机 profiles/' + localProfiles[0] + '（两边都只有一个 profile）',
    };
  }
  return { local: remoteName, note: '本机没有 profiles/' + remoteName + '，按云端的名字新建（云端共 ' + remoteCount + ' 个 profile）' };
}

/** 装配文件要落到哪些 profile：上传用本机名；下载用云端名（可能映射到本机名）。 */
export function profileTargets(cfg = readConfig(), remoteNames = []) {
  if (Array.isArray(remoteNames) && remoteNames.length) {
    const local = profileNames(cfg);
    return remoteNames.map((remote) => ({ remote, ...mapProfileName(remote, local, remoteNames.length) }));
  }
  return profileList(cfg).map((name) => ({ remote: name, local: name, note: '' }));
}

/**
 * 每个同步根：本地目录/文件 ↔ 云端路径。kind=dir 带整棵目录，kind=file 只带一个文件。
 * opts.profiles 传「云端实际存在的 profile 名」时（下载用），远端路径按它们拼，
 * 本机落点由 mapProfileName 决定——这样两台机器 profile 不同名也能拉到装配文件。
 */
export function syncRoots(cfg = readConfig(), opts = {}) {
  const base = String(cfg.syncDir || DEFAULTS.syncDir).replace(/\/+$/, '');
  const names = Array.isArray(cfg.syncDirs) && cfg.syncDirs.length ? cfg.syncDirs : SYNC_DIR_DEFAULT;
  const roots = names.map((name) => ({
    name,
    kind: 'dir',
    label: name,
    local: path.join(cfg.dshHome, name),
    remote: base + '/' + name,
  }));
  const picked = Array.isArray(cfg.syncFiles) ? cfg.syncFiles : SYNC_FILE_DEFAULT;
  const targets = profileTargets(cfg, opts && opts.profiles);
  for (const id of picked) {
    const choice = SYNC_FILE_CHOICES.find((item) => item.id === id);
    if (!choice) continue;
    if (choice.scope === 'root') {
      for (const file of choice.files) {
        roots.push({
          name: file,
          kind: 'file',
          label: choice.label,
          local: path.join(cfg.dshHome, file),
          remote: base + '/' + file,
        });
      }
      continue;
    }
    for (const target of targets) {
      for (const file of choice.files) {
        const remoteRel = 'profiles/' + target.remote + '/' + file;
        const localRel = 'profiles/' + target.local + '/' + file;
        roots.push({
          name: remoteRel,
          kind: 'file',
          label: choice.label,
          local: path.join(cfg.dshHome, localRel),
          remote: base + '/' + remoteRel,
          profile: target.remote,
          localProfile: target.local,
          note: target.note,
        });
      }
    }
  }
  return roots;
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
  cfg.syncProfile = typeof cfg.syncProfile === 'string' ? cfg.syncProfile.trim().slice(0, 64) : '';
  const known = new Set(SYNC_FILE_CHOICES.map((item) => item.id));
  cfg.syncFiles = Array.isArray(cfg.syncFiles) ? [...new Set(cfg.syncFiles.filter((id) => known.has(id)))] : SYNC_FILE_DEFAULT.slice();
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
    syncFiles: cfg.syncFiles,
    syncProfile: cfg.syncProfile,
    profiles: profileList(cfg),
    syncRoots: syncRoots(cfg),
  };
}
