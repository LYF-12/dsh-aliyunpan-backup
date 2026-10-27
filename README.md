# dsh-aliyunpan-backup

把 **DeepSeek Harness（DSH）** 的数据同步到 **阿里云盘** 的 DSH 插件：会话、附件、工作区索引、任务板等目录**逐目录增量镜像**，装配文件（模型配置 / 插件清单）按文件单独带，一台主机推、多台从机拉。

> 图文版使用说明（含流程图）：[`docs/usage.html`](docs/usage.html)

顺手还带一个**解码器**：本地或别人分享的 `payload.enc` 备份包，可以校验完整性、解包落盘。

- 同步是**明文镜像**：云端就是原始目录树，不用口令，能直接在网页版云盘里看/下载（见 §5）
- 解码只处理加密包：口令（KEY.txt）**只在本机**，云端只有密文；解别人分享的包时在页面里临时填对方的口令即可（见 §6）
- 界面：设置 → 插件 → 本插件里一个配置卡片；另有完整配置页 `/api/dsh-aliyunpan-backup/ui`
- 自举安装：找不到 `aliyunpan` 时一键从 GitHub 官方发布装进插件数据目录
- 宿主半侧只依赖 `webServer` 一个服务，浏览器半侧只 require `react`

---

## 1. 能力边界

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 逐目录增量同步到阿里云盘 | 可用 | 一主多从；上传/拉取都做增量比对 |
| 拉回另一台机器的改动 | 可用 | 先下到暂存目录，再由 Node 逐文件比对，**不覆盖正在运行的 DSH** |
| 校验加密包完整性 | 可用 | `payload.enc` 任意位置，按 manifest 逐个 sha256 |
| 解包加密包 | 可用 | 默认落到暂存目录，不覆盖 `.dsh`，人工挑回 |
| 按模块勾选同步内容 | 可用 | 10 个白名单目录多选 + 3 类装配文件（模型配置 / 插件清单 / 凭据），仍不支持任意路径 |
| 路径手输 / 系统选择框 | 可用 | 配置页每个路径旁边都有「浏览…」，弹 Windows 原生文件夹/文件对话框 |
| 打包 + 加密 + 上传 | **已移除**（0.4.0） | 上传交给同步链路；旧包仍可解码 |
| 双向实时同步 | 不支持 | 需要手动点「开始同步」，多机靠锁与索引避免互相踩 |

---

## 2. 安装

### 2.1 前置条件：aliyunpan CLI（可以一键装）

插件本身不实现阿里云盘协议，它调用官方命令行工具 `aliyunpan`（aliyunpan-go）。

**自举安装（0.4.1 起）**：插件找不到 aliyunpan 时，配置卡片和配置页里会多出一个「下载 aliyunpan」按钮。点一下它做三件事：

1. 查 GitHub 官方发布（`tickstep/aliyunpan`）最新版，按当前平台/架构挑包（Windows x64/arm64/x86、Linux amd64/arm64/armv7/386、macOS Intel/Apple Silicon、FreeBSD）；
2. 下载到插件数据目录并解压到 `<插件数据目录>/tools/`，记录 sha256；
3. 跑一次 `aliyunpan --version` 确认能启动，然后把路径写进配置项 `aliyunpanExe`。

不装服务、不写注册表、不需要管理员权限；失败时日志里留着原因和临时目录路径。

**下载不通怎么办（0.4.4 起）**：

1. 官方直连失败后会自动依次试镜像 `ghfast.top`、`gh-proxy.com`（只对 github.com 地址生效），每个源重试 2 次；日志逐条写清失败原因，例如 `官方直连：fetch failed | UND_ERR_CONNECT_TIMEOUT Connect Timeout Error`。
2. 还是不行，就用浏览器/迅雷把 release 里的 `aliyunpan-v*-windows-x64.zip` 下到本机，在配置页「下载不了？」里点「选文件…」，再点「从本地安装」——直接读本地 zip，不再联网。也接受解压好的目录（选目录…）或直接指到 `aliyunpan.exe`。
3. 内网文件服务器也行：把 zip 直链填到自定义下载地址，填过会记住。

常见故障：`fetch failed` 只说明网络层失败（DNS/连接/TLS），真正原因在日志的括号里；`HTTP 404` 是地址指错了版本的文件名。

手动装也完全可以，两者等效：

```powershell
# 1) 拿到 aliyunpan（官方 release 解压，或放进 PATH 里的某个目录）
# 2) 登录一次（会打开浏览器/扫码，凭据存到本机配置目录）
aliyunpan login
# 3) 确认能列目录
aliyunpan ls "/"
```

插件按这个顺序找可执行文件：配置项 `aliyunpanExe` → 插件数据目录 `tools/` → 几个常见安装位置 → **`PATH` 里每一项**。所以只要 `aliyunpan` 在 PATH 里，什么都不用配。

### 2.2 装插件（官方 CLI）

```powershell
# GitHub 安装（需要能访问 github.com）
dsh plugin --profile desktop add github:LYF-12/dsh-aliyunpan-backup

# 本地开发：直接链到工作副本，改完代码重启即生效
dsh plugin --profile desktop add link:D:\Code\deepseek\cs\dsh-aliyunpan-backup
```

> ⚠ 命令行 `dsh plugin add` 只写 `dependencies`，**不会**自动登记 `dsh.profile.bundles`。检查 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 里有没有 `dsh-aliyunpan-backup`，没有就手动加一行，否则启动时不会被装配。插件市场 UI 安装会自动登记。

装完**重启 DSH**，打开 设置 → 插件，找到本插件即可。

### 2.3 更新插件（0.5.0 起，插件内一键）

卡片的按钮行会有「**更新插件到 x.y.z**」（有新版本时）或「检查插件更新」（已最新时）；完整配置页里还有一张「插件更新」卡，能看当前版本、磁盘上的版本、上游版本、安装位置和更新日志。

点一下会发生什么：

1. 查上游最新版本：GitHub API → `raw.githubusercontent.com` → 镜像 `ghfast.top` → 镜像 `gh-proxy.com`，四级兜底，每级都记日志。
2. 下载 `https://github.com/<repo>/archive/refs/heads/main.tar.gz`（同样走「官方直连 → 镜像」+ 每源 2 次重试，复用 §2.1 的下载器）。
3. 解压到临时目录 → 找到含 `package.json`（`name` 是本包）的那一层 → 拷到 `<work>/next`，把旧的 `node_modules` 一起搬进去。
4. 旧目录改名成 `<包目录>.old-<时间戳>`，`next` 替换上去；**任何一步失败都自动换回旧目录**，`.old-` 目录在成功后保留，确认没问题可手动删。
5. **重启 DSH 生效**：宿主半侧代码（路由、服务）已经加载进内存，不重启还是旧逻辑。界面会显示「已更新到 x，重启 DSH 生效」。

两种安装方式都能更新：

- `github:LYF-12/dsh-aliyunpan-backup`（profile 的 `node_modules` 里是一份真实目录）→ 走上面的整目录替换。
- `link:D:\Code\deepseek\cs\dsh-aliyunpan-backup`（指向 git 工作副本）→ 改走 `git pull --ff-only`；目录里没有 `.git` 时会给一句可读提示让你手动拉。

也可以完全不用界面：

```powershell
dsh plugin --profile desktop add github:LYF-12/dsh-aliyunpan-backup   # 等同于装最新版
```

> 为什么不用 pnpm 重装：那要求目标机器上有 pnpm、会动 profile 的锁文件、还会往全局 store 写 hardlink。本包零运行时依赖，所以「换一份文件」和「重装」在结果上等价，副作用更小。

---

## 3. 界面

设置 → 插件 → 本插件是一张卡片：状态徽标、上次结果、几个按钮。徽标口径只有同步：**未同步 / 同步中 / 已上传 / 已拉取**（缺 exe 时显示「缺 aliyunpan」）。

| 按钮 | 作用 |
| --- | --- |
| 同步上传 | 把本机选中的目录推到云端（增量） |
| 从机拉取 | 把云端内容拉回本机（增量 + 可选严格镜像） |
| 刷新 | 重新读状态/日志 |
| 打开完整配置页 / 复制配置页地址 | 卡片里内嵌完整页面；宿主拦弹窗时用复制地址 |
| 下载 aliyunpan | **只在找不到 exe 时出现**，一键自举安装（见 §2.1） |
| 更新插件到 x / 检查插件更新 | 有新版本时显示前者，点一下自更新（见 §2.3）；更新后需重启 DSH |

完整配置页（`/api/dsh-aliyunpan-backup/ui`）八张卡：运行环境、插件更新、同步、解码本地包、口令、路径配置、解码日志；「运行环境」卡显示 aliyunpan 是否就绪、版本、安装路径、安装进度日志，以及自定义下载地址。

所有路径输入框旁边都有按钮：

- 目录类 → **浏览…**（FolderBrowserDialog）
- 文件类（`KEY.txt`、`payload.enc`、`aliyunpan.exe`）→ **浏览…**（OpenFileDialog）
- 包卡片单独给「选文件夹…」「选文件…」两个，因为包既可能是一个目录，也可能直接是 `payload.enc`

对话框由宿主进程拉起的 PowerShell 弹出，选完自动回填；没有桌面会话或非 Windows 时直接手输，功能不受影响。

---

## 4. 一次性准备（主机）

0. （没装过的话）在配置页「运行环境」里点「下载并安装 aliyunpan」，装完再 `aliyunpan login` 登录。
1. `aliyunpan login` 登录（每台机器各自登录）。
2. 打开完整配置页，在「同步」卡片勾选要同步的目录（默认 `sessions` / `attachments` / `storages` / `task-board`），再勾要带的装配文件（默认「模型与插件装配」+「插件清单」，见 §5.2）。
3. 点「预演」看一眼文件数与体积，再点「开始同步」做首次全量上传。
4. 同步设置点「保存同步设置」持久化（机器名会自动取计算机名）。

---

## 5. 同步（逐目录镜像）

### 5.1 上传（主机 → 云端）

每个目录一个云端前缀：`<syncDir>/<目录名>`，默认 `/DeepSeek Harness/DSH-Sync/sessions` 等。

- **增量靠本地索引**：`sync-index.json` 记录 `相对路径 → {size, mtime}`。
  - 新增文件 → `upload --skip`（云端同名则跳过，不会产生 `name(1).ext` 副本）
  - 修改文件 → `upload -ow`（覆盖）
  - 无变化 → 零上传，秒回。
- 索引不存在（首次同步 / 索引被删）→ 该目录走**全量 `-ow`**，避免「按名字跳过」导致内容永远停留在旧版本。
- 上传按云端父目录分组、每批 ≤20 个文件，`-p 4` 并发。
- `syncPrune` 打开时，云端多余文件会被删（默认关闭）。

### 5.2 装配文件（模型配置 / 插件清单 / 凭据）

目录同步解决「数据」，换台电脑还缺「环境」：模型列表、插件清单这些是本机装配出来的，不在 `sessions` 里。所以额外给三个**文件级**选项：

| 选项 | 带哪些文件 | 云端位置 | 默认 |
| --- | --- | --- | --- |
| 模型与插件装配 | `profiles/<profile>/cordis.patch.yml` | `DSH-Sync/profiles/<profile>/cordis.patch.yml` | 勾 |
| 插件清单 | `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` | 同上目录 | 勾 |
| 登录凭据 | `.credentials.yaml` | `DSH-Sync/.credentials.yaml` | **不勾** |

- 模型 provider 与模型列表在 `cordis.patch.yml` 里，但 **API Key 不在里面**，Key 在 `.credentials.yaml`（明文 YAML）。所以「勾上模型配置」不会顺带把 Key 传上去。
- 想连 Key 一起带走，得显式勾「登录凭据」。这是**明文上云**，只建议私有盘、自己的账号。
- `profiles/` 整棵目录不能同步：里面是几十万个 `node_modules` 文件。插件清单的用途是**在另一台机器上照着重装**，不是直接拷文件。
- 装配文件按**文件**比对（size + mtime），上传固定 `-ow` 覆盖，不会产生 `name(1).yml` 副本。
- 「装配文件用哪个 profile」留空 = 本机第一个真实存在的 profile（跳过 `_bak-*`）。两台机器 profile 名字不一样时，在这一栏填对方的目录名（如 `desktop`）。

### 5.3 拉取（云端 → 从机）

```text
# 1) CLI 只负责把云端目录下到暂存区
# 2) Node 再按 size+mtime 逐文件镜像进 .dsh
aliyunpan download --saveto <暂存目录> --ow -p 3 <云端目录>
```

**不让 CLI 直接写 `.dsh`** 的原因有两条：CLI 会自作主张多建一层 `DeepSeek Harness\DSH-Sync\` 目录；而且要逐文件比对才能做到「只写变化的部分」。所以先用 CLI 下到 `syncDlDir`，再由 Node 复制。

- 默认**只增不删**：本机多出来的文件保持原样。
- `syncPrune` 打开 = 严格镜像，会删本机多余文件。**先确认再开。**
- 拉取前请先退出 DSH：正在运行的应用握着会话文件，Windows 上写盘会被拒。

### 5.4 多机与锁

- 每台机器写入 `_last-sync-<机器名>.json`，借此判断「另一台机器最近是否同步过」。
- `syncLockMinutes`（默认 60）内有其它机器活动时：默认只**告警**继续，`--strict` 下直接退出。
- 两台机器同时上传同一批文件没有合并逻辑：**约定一台主机推、其它只拉**最省事。

### 5.5 三个坑

1. `Access is denied` / 暂存目录被拦 → 安全软件拦了 `aliyunpan.exe` 写盘。日志会打 `[hint]`，把 `syncDlDir` 换到允许的目录，或给 exe 加白。
2. 不要用 `aliyunpan sync start`（CLI 自带同步）。它自己维护状态、和本插件的索引互相打架，行为不可预期。
3. 先退出 DSH 再拉取，否则 `ledger-v2.lock` 之类的锁文件写不进去。

### 5.6 命令行等价物

```powershell
# 预演：只统计，不动云端
node lib/scripts/syncd.mjs --mode plan
# 上传 / 拉取
node lib/scripts/syncd.mjs --mode upload
node lib/scripts/syncd.mjs --mode download --prune
# 加 --strict：发现其它机器活动就退出
```

输出末行固定是 `SYNC RESULT: mode=... roots=N files=N failed=N`。

---

## 6. 解码本地包

给两类包用：**旧版 0.3.x 及更早**打的加密备份包、**别人分享**的包。

### 6.1 包长什么样

```text
<包目录>/
  payload.enc          # 密文：36B header + 每 1MiB 一块 tag16|ciphertext
  package.info.json    # 明文元信息：createdAt / fileCount / totalBytes
```

容器格式：`DSHBK002` | salt16 | noncePrefix4 | plainBytes(u64LE)，AES-256-GCM 分块，`scrypt(passphrase, salt, 32)`，AAD `dshbk-chunk-<i>`。明文是 `DSHBUNDLE1` 容器，内含 `manifest.json`（每个文件的路径/大小/sha256）。

### 6.2 页面上的操作

1. 「解码本地包」卡片里填路径：可以直接填 `payload.enc` 的完整路径，也可以填包目录（`...\20261026T1917-full`）。
2. 「检查这个包」→ 显示文件数/体积/创建时间。
3. 「校验完整性」→ 只解密比对，不落盘，结果 `verify: ok=N bad=0 missing=0`。
4. 「解包」→ 落到 `输出目录`（留空 = 暂存目录 `restore\<包名>`），写一份 `RESTORE-manifest.json`。**不会覆盖 `.dsh`**，自己挑需要的文件拷回去。

口令那栏留空 = 用本机 `KEY.txt`；解别人的包时直接填对方给的口令（不走口令文件，也不会写盘）。

卡片下方还会列出暂存目录 `snapshots\` 里扫到的包，点一行即可选中。

### 6.3 换电脑还原旧包

```powershell
aliyunpan ls "/DeepSeek Harness/DSH-Backup/snapshots"
aliyunpan download --saveto "D:\DSH-Backup\snapshots" "<云端路径>"
# 拿到对方/旧机器的 KEY.txt，或直接在解码卡片里填口令
```

然后在页面里校验 → 解包 → 挑文件拷回 `%USERPROFILE%\.dsh`。

### 6.4 退出码（命令行 / 日志）

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 2 | 缺参数（`--pkg` / `--out`） |
| 3 | 不是 `DSHBK002` 容器（文件不对） |
| 4 | `AUTH FAIL at chunk N`：口令错或包损坏 |
| 5 | 明文不是 `DSHBUNDLE1`（包结构坏） |
| 6 | 校验失败（有 bad/missing 文件） |

---

## 7. 配置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dshHome` | `~/.dsh` | 要同步的 DSH 数据目录 |
| `syncDir` | `/DeepSeek Harness/DSH-Sync` | 云端同步根 |
| `syncDirs` | `[sessions, attachments, storages, task-board]` | 同步哪些目录（10 选多） |
| `syncMode` | `upload` | `upload` / `download` |
| `syncMachine` | 空 = 计算机名 | 锁与留痕用的机器标识 |
| `syncLockMinutes` | `60` | 其它机器活动窗口；0 = 不检查 |
| `syncDlDir` | 空 = 插件目录 `sync-dl` | 拉取暂存目录 |
| `syncPrune` | `false` | 拉取时删本机多余文件 |
| `syncFiles` | `[model, plugins]` | 装配文件：`model` / `plugins` / `credentials`（凭据默认不勾） |
| `syncProfile` | 空 = 自动 | 装配文件用哪个 profile 名；新机器 profile 还没建时也可填 |
| `stagingDir` | 空 = `D:\DSH-Backup`（存在时）否则 插件目录 `staging` | 包与解包临时区 |
| `keyFile` | 空 = `staging\KEY.txt` | 本机口令文件 |
| `restoreDir` | 空 = `staging\restore\<包名>` | 解包输出目录 |
| `aliyunpanExe` | 空 = 自动探测 | CLI 路径（自举安装会写这里） |
| `aliyunpanUrl` | 空 = GitHub 官方发布 | 自举安装的自定义下载地址（镜像 / 内网文件服务器，必须 http(s) 且指到压缩包）；只想用本地包时留空，在配置页点「从本地安装」 |

配置存放在 `~/.dsh/dsh-aliyunpan-backup/config.json`（可用 `DSH_AB_HOME` 改插件数据目录、`DSH_AB_CONFIG` 直接指定配置文件）。

---

## 8. HTTP 路由（16 条，全部 exact + 仅 loopback）

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/api/dsh-aliyunpan-backup/ui` | GET | 完整配置页 |
| `/status` | GET | 状态 + 可解码包列表 + 日志尾巴 |
| `/config` | GET/POST | 读/存配置（字段白名单） |
| `/inspect?pkg=` | GET | 探测某个路径是不是包 |
| `/restore` | POST | 校验或解包（`pkg`/`out`/`passphrase`/`verifyOnly`） |
| `/key` | GET/POST | 口令：查看/设置/生成 |
| `/log` | GET | 解码日志 |
| `/sync` | GET | 同步配置与最近状态 |
| `/sync/plan` | GET | 预演统计 |
| `/sync/run` | POST | 开始同步（`{mode}`） |
| `/sync/cancel` | POST | 取消同步 |
| `/provision` | GET | aliyunpan 运行环境 + 安装状态与日志 |
| `/provision/run` | POST | 自举安装（`{url}` 覆盖下载地址、`{tag}` 指定版本、`{local}` 用本地 zip/目录安装） |
| `/pick` | POST | 弹系统选择框：`{kind, initial, title}`（kind = `dir` 或 `file`）→ `{ok, path}`；取消/超时 409 |
| `/update` | GET | 自更新状态；`?check=1` 会去查一次上游（不传时首次访问也会顺手查一次） |
| `/update/run` | POST | 开始更新，`{profile}` 可选；已在更新时 409 |

---

## 9. 安全

- **同步是明文**：云端目录可以直接打开看。会话与附件里有隐私内容，介意就别同步这些目录。
- **口令只在本机**：`KEY.txt` 不随同步上传（它在插件数据目录，不在同步白名单里）。丢了口令，旧包就永久打不开。
- `KEY.txt` 写入用 `mode: 0o600`，但 **Windows 忽略 POSIX 权限位**，实际靠 `%USERPROFILE%` 的目录 ACL 保护。
- 日志只记路径、文件数、耗时、退出码，不记口令与文件内容。
- 路由只接受 loopback 请求，非本机地址一律 403。

---

## 10. 常见问题

**Q：第一次同步很久？** 全量上传，取决于体积。之后只传新增/修改。

**Q：云端出现 `name(1).ext`？** 说明同一次上传里出现了同名且未加 `--skip`。本插件新增走 `--skip` 不会产生副本；若已产生，删掉副本再同步一次。

**Q：同步会不会把我整个 `.dsh` 传上去？** 不会。只传 `syncDirs` 里那几个目录（跳过 `node_modules`、`.git`、符号链接），外加 `syncFiles` 勾选的几个装配文件。

**Q：模型信息和 API Key 同步了吗？** 模型列表在 `profiles/<profile>/cordis.patch.yml`，勾「模型与插件装配」就会带；**Key 在 `.credentials.yaml`，默认不带**，要带得显式勾「登录凭据」（明文上云）。

**Q：插件本身会同步过去吗？** 会带 `package.json` + 锁文件，但不会传 `node_modules`。另一台机器用 `dsh plugin add` 照清单重装，比拷几十万文件快。

**Q：两台机器同时同步会怎样？** 会互相覆盖。用 `syncLockMinutes` + 一主多从的约定。

**Q：解包会不会覆盖正在用的数据？** 不会。解到独立目录，自己挑。

**Q：还要备份加密包吗？** 0.4.0 起不做打包上传了。要异地留档：同步一份明文，或自行打包后传到云盘再解码。

---

## 11. 开发与测试

```powershell
node --check lib/index.js      # 宿主半侧
node --check lib/client.js     # 浏览器半侧
node test/smoke.mjs            # 路由/配置/UI/客户端组件断言（14 条路由 + 装配文件根）
node test/e2e.mjs              # 造一个真实加密包 → 校验 → 错口令 → 解包 → 逐字节比对
```

目录：

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 宿主半侧：14 条路由 + 配置读写 + 口令 + 系统选择框 |
| `lib/client.js` | 设置卡片：同步上传 / 从机拉取 / 内嵌完整页 |
| `lib/config.mjs` | 默认值、白名单、路径解析、`aliyunpan` 探测 |
| `lib/provision.mjs` | 自举安装：查发布、挑包、下载（重试 + 镜像回退 + 本地包）、校验、解压、试跑、写配置 |
| `lib/runner.mjs` | 解码任务：解析包路径、起子进程、日志/状态 |
| `lib/syncplan.mjs` | 预演统计 |
| `lib/syncrun.mjs` | 同步任务进程管理 |
| `lib/scripts/restore.mjs` | 解密 / 校验 / 解包 |
| `lib/scripts/syncd.mjs` | 同步执行体（plan/upload/download） |
| `lib/ui.html` | 完整配置页（单文件） |
| `test/fixtures/make-package.mjs` | 按 0.3.x 格式造包（加密） |

---

## 12. 变更记录

### 0.5.0

- **插件内自带更新按钮**（用户提的「插件里面要有更新按钮」）：不用再去命令行或插件市场，卡片上直接「更新插件到 x.y.z」，完整配置页多了「插件更新」卡（当前版本 / 磁盘版本 / 上游版本 / 安装位置 / 实时日志）。
- 更新实现不依赖 pnpm：下载 GitHub 源码 tarball → 解压 → 整目录原子替换（旧目录先改名 `.old-<时间戳>`，失败自动回滚），下载复用 0.4.4 的「官方直连 → ghfast.top → gh-proxy.com」+ 每源 2 次重试；`link:` 安装改走 `git pull --ff-only`。
- 版本查询四级兜底：GitHub API（`contents` + raw accept）→ `raw.githubusercontent.com` → 两个镜像；全挂时给出逐条失败原因，不会假装「已是最新」。
- 更新完成后明确提示「重启 DSH 生效」，不做自动重启（重启会掐掉正在跑的同步）。
- 路由 14 → 16（`/update`、`/update/run`）；测试环境变量 `DSH_AB_NO_UPDATE_CHECK=1` 可关掉首次自动检查（smoke 用它避免打网络）。

### 0.4.4

- **修「另一台机器装不上 aliyunpan」**：报错只有 `fetch failed` 一句话，看不出是 DNS、连接还是 TLS 挂的。现在 `describeError()` 会把 `error.cause` 链展开（如 `fetch failed | UND_ERR_CONNECT_TIMEOUT Connect Timeout Error`），日志逐条记录每个源的失败原因。
- **下载不再一次失败就放弃**：源顺序「官方直连 → 镜像 ghfast.top → 镜像 gh-proxy.com」，每个源重试 2 次；4xx（除 408/429）不重试、直接换源。看门狗改成「45 秒没有新数据才算卡死 + 整体 10 分钟封顶」，慢速网络不会因为总耗时被误杀。
- **新增本地安装**：配置页「下载不了？」里可以选一个本地 `.zip` / `.tar.gz`，或直接选解压好的目录，走 `/provision/run` 的 `{local}` 分支；同样会解压、`--version` 试跑、写 `aliyunpanExe`。浏览器/迅雷下载党不再被网络卡死。
- 测试：`describeError` 嵌套 cause、`downloadSources` 对 github / 非 github / file:// 的源列表、本地目录安装（真机 e2e 装到临时 home 并跑通 v0.4.0）、路径不存在的拒绝、404 地址的换源与错误明细。

### 0.4.3

- **修界面挤不下**：设置页里配置卡右侧被裁掉、出现横向滚动条。原因是 CSS 网格的隐式列按 `max-content` 撑开，一行超长内容（aliyunpan 日志、云端长路径、同步预演表格的「云端位置」）就把整页推宽。四处收口：`.wrap` 改 `grid-template-columns: minmax(0, 1fr)`、卡片加 `min-width: 0`、日志 `pre` 改 `white-space: pre-wrap` + `overflow-wrap: anywhere`（原来只能横向拖）、表格改 `table-layout: fixed` 并允许单元格断词。
- 内嵌配置页 iframe 不再固定 680px：宽度 100%、高度 `clamp(420px, 70vh, 780px)`，窄侧栏里不会出双滚动条；配置卡也加了 `min-width: 0` 与长文本断行。
- 验证：Edge headless + CDP 在 980/900/760/640/520 五个宽度量 `document.scrollWidth`，注入超长日志与长路径后旧版溢出 649–1129px（`.wrap` 撑到 1592px），新版五个宽度全部 0 溢出。

### 0.4.2

- **装配文件也能同步了**：新增文件级同步项 —— 模型与插件装配（`cordis.patch.yml`）、插件清单（`package.json` + 锁文件）、登录凭据（`.credentials.yaml`，默认不勾）。回答「模型信息和 key 为什么没同步」：Key 不随模型配置走，要单独勾且是明文上云。
- 新增 `syncFiles` / `syncProfile` 配置项；本机还没有 profile 目录时按 `syncProfile`（默认 `desktop`）展开，保证全新机器也能拉到装配文件。
- **路径不再只能手填**：配置页所有路径/文件输入框加「浏览…」，调宿主弹 Windows 原生 FolderBrowserDialog / OpenFileDialog，选完回填；新增 `/pick` 路由（14 条）。
- 卡片状态徽标改成只看同步：未同步 / 同步中 / 已上传 / 已拉取。之前显示「尚未运行」是拿解码任务的状态当同步状态，容易误以为没跑起来。
- 修 `plan` 把文件根重复算成目录根的问题（roots 翻倍）；文件根单独走 upload/download 单文件分支。
- 测试：装配文件根的配置白名单、目录展开（跳过 `_bak-*`）、缺失文件汇报、`/pick` 非 POST 拒绝；真机 e2e 用两台假 home 验证「上传 3 文件 → 拉取 3 文件 → 逐字节一致」。

### 0.4.1

- **新增自举安装 aliyunpan**：找不到 CLI 时卡片上出现「下载 aliyunpan」，从官方 release 下载 → 解压到 `tools/` → 记录 sha256 → `--version` 试跑 → 自动写 `aliyunpanExe`。
- 配置页新增「运行环境」卡（状态/版本/路径/安装日志/自定义下载地址），配置新增 `aliyunpanUrl`，路由新增 `/provision`、`/provision/run`。
- 资产匹配按平台+架构精确选择（含 `darwin-macos-*`、`windows-x86`、`linux-armv7` 等真实命名），排除 android/ios 包；无可选包时给出可读原因。
- 测试新增：资产矩阵（10 组平台/架构）、不可达地址的失败路径、非 http 地址拒绝。

### 0.4.0

- **移除**打包 + 加密 + 上传链路（`/run`、`/cancel`、`build.mjs`、`sync.mjs`）：上传交给同步。
- **新增**解码器：`/inspect` + `/restore` 接受任意本地路径或包目录，支持临时口令解别人分享的包。
- 状态接口返回 `packages`（暂存目录扫到的包），页面「本地快照」改为「解码本地包」。
- 配置瘦身：去掉 `remoteDir` / `keep` / `includeFeishuFiles` / `includeCredentials`。
- 测试补齐：新增 `test/e2e.mjs` 与包生成 fixture（真实 AES-256-GCM，非 mock）。

### 0.3.0

- 新增逐目录镜像同步（上传增量 / 拉取镜像 / 预演 / 取消 / 多机锁）。
- 同步不再依赖加密包，云端是原始目录树。

### 0.2.x

- 换机可移植性：`aliyunpan` 自动探测（含 PATH）、暂存目录自动创建、口令迁移接口 `/key`。
- 修复 `profiles/<profile>/` 下的配置文件从未进包（`rel.length !== 3`）。
- 凭据类根文件默认不进包（`.credentials.yaml` / `.npmrc` / `*.key|pem|p12|pfx`）。

### 0.1.x

- 首个版本：扫描 → 打包 → AES-256-GCM → 上传 → 回读校验 → 按份数剪枝；图标与设置卡片。

---

MIT License
