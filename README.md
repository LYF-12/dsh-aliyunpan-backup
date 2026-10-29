# dsh-aliyunpan-backup

把 **DeepSeek Harness（DSH）** 的数据同步到 **阿里云盘** 的 DSH 插件：会话、附件、工作区索引、任务板等目录**逐目录增量镜像**，装配文件（模型配置 / 插件清单）按文件单独带，一台主机推、多台从机拉。

> 图文版使用说明（含流程图）：[`docs/usage.html`](docs/usage.html)

顺手还带一个**解码器**：本地或别人分享的 `payload.enc` 备份包，可以校验完整性、解包落盘。

- 同步是**明文镜像**：云端就是原始目录树，不用口令，能直接在网页版云盘里看/下载（见 §5）；唯一的例外是开了「密钥信封」后的登录凭据（见 §5.3）
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
| 凭据加密同步（密钥信封） | 可用（0.5.3） | 可选：`.credentials.yaml` 用口令加密成 `.credentials.yaml.enc` 上传，云端只有密文，换机同口令还原（见 §5.3） |
| 工作区路径重映射 | 可用（0.5.4） | 从机拉取后自动把 `workspace.json` 里本机不存在的绝对路径换到能用的位置（换盘符 / Documents / 手动前缀映射），改前留 `.bak`（见 §5.5） |
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

### 2.3 登录阿里云盘（0.5.1 起，页面里点，不用开终端）

两台机器**必须登录同一个阿里云盘账号**，否则另一台看云端就跟空的一样。

1. 打开配置页（插件卡〔打开完整配置页〕），最上面的「阿里云盘账号」卡会显示已登录的昵称/UID 或「未登录」。
2. 点〔登录阿里云盘〕→ 等几秒，卡片里出现授权链接（`https://openapi.alipan.com/oauth/authorize…`）。
3. 点〔打开链接〕（或〔复制链接〕粘到浏览器）→ 点「允许」→ 自动跳到二维码页 → 手机阿里云盘 APP 扫码确认。
4. 回到配置页点〔我已扫码，继续〕（等于给 `aliyunpan login` 敲了个回车）→ 状态变「已登录」，显示昵称与 UID 前 8 位。
5. 链接 5 分钟有效；过期就〔取消〕再重新〔登录阿里云盘〕。

> 命令行等价：`aliyunpan login`（同样要浏览器授权 + 扫码 + 回车），`aliyunpan who` 看当前账号。

### 2.4 更新插件（0.5.0 起，插件内一键）

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

设置 → 插件 → 本插件是一张卡片：状态徽标、上次结果、几个按钮、一块可展开的**运行日志**。徽标口径只有同步：**未同步 / 同步中 / 已上传 / 已拉取**（缺 exe 时显示「缺 aliyunpan」）。

同步中还会显示「已运行 3 分 12 秒 · 最近输出 12 秒前」；只要子进程卡住没输出，超过「无输出超时」就会自动中止并把原因写进日志 —— 不会出现「一直同步中」下不来的状态。上次的进程已经不在了但状态文件还停在 running 时，卡片会提示「上次的同步进程（pid N）可能还卡着」，并给一个「结束任务」按钮。

| 按钮 | 作用 |
| --- | --- |
| 同步上传 | 把本机选中的目录推到云端（增量） |
| 从机拉取 | 把云端内容拉回本机（增量 + 可选严格镜像） |
| 刷新 | 重新读状态/日志 |
| 打开完整配置页 / 复制配置页地址 | 卡片里内嵌完整页面；宿主拦弹窗时用复制地址 |
| 下载 aliyunpan | **只在找不到 exe 时出现**，一键自举安装（见 §2.1） |
| 更新插件到 x / 检查插件更新 | 有新版本时显示前者，点一下自更新（见 §2.4）；更新后需重启 DSH |
| 运行日志 / 收起日志 | 展开卡片里的日志面板（默认 200 行，可加载更多、一键复制）；排查问题先看这里 |

完整配置页（`/api/dsh-aliyunpan-backup/ui`）八张卡：阿里云盘账号、运行环境、插件更新、同步、解码本地包、口令、路径配置、解码日志。

**默认只显示高频卡**（账号、同步），其余（运行环境 / 插件更新 / 解码本地包 / 口令 / 路径配置 / 解码日志）收在头部「显示全部设置」开关后面；同步卡的低频字段（机器标识、互斥窗口、装配 profile、暂存目录、路径映射、超时保护）收在「高级设置」折叠区，日志收在「运行日志」折叠区。开关状态记在 localStorage。页面在窄侧栏（500 px 左右）也不会横向溢出。

「运行环境」卡显示 aliyunpan 是否就绪、版本、安装路径、安装进度日志，以及自定义下载地址。

所有路径输入框旁边都有按钮：

- 目录类 → **浏览…**（FolderBrowserDialog）
- 文件类（`KEY.txt`、`payload.enc`、`aliyunpan.exe`）→ **浏览…**（OpenFileDialog）
- 包卡片单独给「选文件夹…」「选文件…」两个，因为包既可能是一个目录，也可能直接是 `payload.enc`

「同步」卡除了目录与装配文件，还有四项（见 §5.3 / §5.5）：加密同步登录凭据（密钥信封）、拉取后把工作区路径改到本机、工作区路径映射、不同步的 profile。

对话框由宿主进程拉起的 PowerShell 弹出，选完自动回填；没有桌面会话或非 Windows 时直接手输，功能不受影响。

---

## 4. 一次性准备（主机）

0. （没装过的话）在配置页「运行环境」里点「下载并安装 aliyunpan」，装完再 `aliyunpan login` 登录。
1. `aliyunpan login` 登录（每台机器各自登录）。
2. 打开完整配置页，在「同步」卡片勾选要同步的目录（默认 `sessions` / `attachments` / `storages` / `task-board`），再勾要带的装配文件（默认「模型与插件装配」+「插件清单」，见 §5.2）。想连登录凭据一起带走就勾「加密同步登录凭据（密钥信封）」，并在「口令（KEY.txt）」里生成/粘贴同一串口令（见 §5.3）。
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
| 登录凭据（明文） | `.credentials.yaml` | `DSH-Sync/.credentials.yaml` | **不勾**（推荐改用 §5.3 的密钥信封） |

- 模型 provider 与模型列表在 `cordis.patch.yml` 里，但 **API Key 不在里面**，Key 在 `.credentials.yaml`（明文 YAML）。所以「勾上模型配置」不会顺带把 Key 传上去。
- 想连 Key 一起带走有两条路：显式勾「登录凭据」= **明文上云**（只建议私有盘、自己的账号）；或者开 **密钥信封**（§5.3），凭据加密成单文件上传，云端只有密文 —— 推荐这条。
- `profiles/` 整棵目录不能同步：里面是几十万个 `node_modules` 文件。插件清单的用途是**在另一台机器上照着重装**，不是直接拷文件。
- 装配文件按**文件**比对（size + mtime），上传固定 `-ow` 覆盖，不会产生 `name(1).yml` 副本。
- **上传**：「装配文件用哪个 profile」留空 = 本机第一个真实存在的 profile（跳过 `_bak-*`）。
- **拉取（0.5.2 起）**：先 `ls <syncDir>/profiles` 问云端实际有哪些 profile，再去拼 `profiles/<云端名>/cordis.patch.yml`，所以不需要你在配置里填对方的目录名。落地时有三种情况，日志会逐条打出来：

  | 云端 profile | 本机 profile | 落到哪里 |
  | --- | --- | --- |
  | `desktop` | 有同名 `desktop` | `profiles/desktop/`（原样） |
  | 只有 `desktop` | 只有 `solo` | `profiles/solo/`（两边都只有一个，1:1 映射） |
  | `desktop` + `web` | 只有 `solo` 或都没有 | 按云端名字各建 `profiles/desktop/`、`profiles/web/` |

  多个云端 profile 不做合并映射：往同一个本机文件写两份会互相覆盖，宁可各建各的目录，你重启时自己选。

### 5.3 密钥信封：加密同步登录凭据（0.5.3 起，可选）

`.credentials.yaml` 里是明文 API Key 与账号 token。直接勾「登录凭据」等于明文上云；更稳的做法是开「密钥信封」：用本机口令把它加密成一个文件再上传。

| | 不开信封 | 开信封（`credentialsEnvelope: true`） |
| --- | --- | --- |
| 云端文件 | `DSH-Sync/.credentials.yaml`（明文） | `DSH-Sync/.credentials.yaml.enc`（AES-256-GCM 密文） |
| 换机器还原 | 下下来就是明文 | 必须同一个口令，解出后写到本机 `~/.dsh/.credentials.yaml` |
| 口令丢了 | 不影响 | 那个信封永久打不开（Key 仍在本机，不算丢数据） |
| 每次同步 | 按 size+mtime 传变化 | 同左，内容没变不重传 |

**怎么开**：配置页「同步」卡 → 勾「加密同步登录凭据（密钥信封）」→ 保存。勾上后「登录凭据（明文）」那一项会自动置灰 —— 同一份凭据不留两个副本。plan 预演里会多出 `.credentials.yaml.enc` 这一行。

**两台机器必须同一个口令**：口令在 `keyFile`（默认 `<插件数据目录>\KEY.txt`），不随同步上传。新机器在配置页「口令（KEY.txt）」里粘贴主机那串，再「从机拉取」。命令行等价：

```text
node lib/scripts/syncd.mjs --mode upload     # 生成 .credentials.yaml.enc 并上传
node lib/scripts/syncd.mjs --mode download   # 下载密文并解密写回 .credentials.yaml
```

- 加密细节：scrypt(N=32768,r=8,p=1) 派生 32 字节密钥 + AES-256-GCM，随机 salt(16)/nonce(12)，AAD 固定 `dsh-credentials-v1`；文件格式 `magic "DSHKEY01"(8) | salt(16) | nonce(12) | ciphertext | tag(16)`。
- 口令错或密文被改过都只报「口令不对（或信封被改过），解密失败」，**不会写坏本机凭据**；本机已有不同内容时先备份成 `.credentials.yaml.bak-<时间戳>` 再覆盖。
- 未登录/无凭据时不报错：本机没有 `.credentials.yaml` 就跳过；没有口令会打 `[warn]` + `[hint] 先在配置页「口令（KEY.txt）」里生成或粘贴口令`。
- 信封与「旧加密包」共用 `KEY.txt`，但用途互不影响（同一串口令两处都能用）。

### 5.4 拉取（云端 → 从机）

```text
# 1) CLI 只负责把云端目录下到暂存区
# 2) Node 再按 size+mtime 逐文件镜像进 .dsh
aliyunpan download --saveto <暂存目录> --ow -p 3 <云端目录>
```

**不让 CLI 直接写 `.dsh`** 的原因有两条：CLI 会自作主张多建一层 `DeepSeek Harness\DSH-Sync\` 目录；而且要逐文件比对才能做到「只写变化的部分」。所以先用 CLI 下到 `syncDlDir`，再由 Node 复制。

- 默认**只增不删**：本机多出来的文件保持原样。
- `syncPrune` 打开 = 严格镜像，会删本机多余文件。**先确认再开。**
- 拉取前请先退出 DSH：正在运行的应用握着会话文件，Windows 上写盘会被拒。
- 云端 profile 名会被自动发现（`[info] 云端 profile: desktop、web`），落地目录名按 §5.2 的规则映射，不用手动改配置。
- 拉取完会自动处理工作区路径（0.5.4 起）：`workspace.json` 里那些本机不存在的绝对路径会被改到能找到的位置，改前备份（见 §5.5）。

### 5.5 工作区路径重映射（0.5.4 起）

`storages/workspace.json` 把每个工作区记成**绝对路径**（`D:\Code\deepseek\cs` 这种）。换一台电脑，这些盘符/目录往往不存在，DSH 打开时工作区是空的、路径无效 —— 这一步在拉取后自动修。

拉取结束（且本次同步包含 `storages`）时会：

1. 读本机 `<dshHome>/storages/workspace.json`；
2. 对每个工作区路径依次尝试候选：**手动映射**（你自己的前缀规则）→ **换盘符**（`X:\a\b` 的盘符不存在就试本机其它存在的盘符）→ `<用户>\Documents\<目录名>` → `<用户>\<目录名>`；
3. 只采用 `exists()` 为真的候选；改之前把原文件备份成 `workspace.json.bak-<YYYYMMDDTHHMMSS>`；
4. 结果写 `workspace-remap.json`，日志逐条打出来：

```text
[info] 工作区「测试」路径：Z:\Code\deepseek\cs → D:\Code\deepseek\cs（手动映射 Z:\Code => D:\Code）
[warn] 工作区「无解」本机不存在：Z:\Nope\zzz
[hint] 自动找不到替代位置，可在配置页「工作区路径映射」里写一行 原前缀=>新前缀，再拉一次。
[info] 已改 1 个工作区路径；原文件备份：…\workspace.json.bak-20261028T030202
```

**手动映射**（配置页「工作区路径映射」，或 `workspaceMap`）：一行一条，`原前缀=>新前缀`，也接受 `->`，`#` 开头是注释。

```text
D:\Code=>C:\Work\Code        # 整个 D:\Code 树搬到 C:\Work\Code
E:\Old -> F:\New
```

- 只做前缀替换：`D:\Code\deepseek\cs` 会变成 `C:\Work\Code\deepseek\cs`，然后仍然要 `exists()` 通过才采纳。
- 本机已经存在的路径一律不动（所以同一台机器重复拉取不会来回改）。
- 找不到替代位置的工作区**保持原样**，只在日志里 `[warn]`，不会让同步失败。
- 不想要这一步：配置页取消勾选「拉取后把工作区路径改到本机」（`workspaceRemap: false`），`workspace.json` 原样落地。
- `workspace.json` 是拉取时被覆盖的文件 —— 手工改过本机工作区列表的话，先退出 DSH 再拉，避免被写回去。

**不同步的 profile**（`syncProfileExclude`）：填 `abtest, tmp` 这样的名字（逗号/分号/空格分隔，最多 20 个），本机会跳过这些 profile 的装配文件 —— 测试用的 profile 就不会传到别的机器上多建一个目录。云端已有同名目录的话需要手动删 `/DeepSeek Harness/DSH-Sync/profiles/<名字>`。
### 5.6 多机与锁

- 每台机器写入 `_last-sync-<机器名>.json`，借此判断「另一台机器最近是否同步过」。
- `syncLockMinutes`（默认 60）内有其它机器活动时：默认只**告警**继续，`--strict` 下直接退出。
- 两台机器同时上传同一批文件没有合并逻辑：**约定一台主机推、其它只拉**最省事。

### 5.7 三个坑

1. `Access is denied` / 暂存目录被拦 → 安全软件拦了 `aliyunpan.exe` 写盘。日志会打 `[hint]`，把 `syncDlDir` 换到允许的目录，或给 exe 加白。
2. 不要用 `aliyunpan sync start`（CLI 自带同步）。它自己维护状态、和本插件的索引互相打架，行为不可预期。
3. 先退出 DSH 再拉取，否则 `ledger-v2.lock` 之类的锁文件写不进去。

### 5.8 命令行等价物

```powershell
# 预演：只统计，不动云端
node lib/scripts/syncd.mjs --mode plan
# 上传 / 拉取
node lib/scripts/syncd.mjs --mode upload
node lib/scripts/syncd.mjs --mode download --prune
# 加 --strict：发现其它机器活动就退出
```

输出末行固定是 `SYNC RESULT: mode=... roots=N files=N failed=N`。

### 5.9 拉取不会弄丢本机记录（0.6.0）

以前拉取是「云端有什么就盖什么」，三个地方会吃掉本机数据，现在都堵上了：

| 场景 | 旧行为 | 现在 |
| --- | --- | --- |
| 本机会话比云端长（DSH 还在追加写，size 变大） | 被云端旧版覆盖，记录变短 | **本机文件更大就不覆盖**，云端版本只放进回收站 |
| `storages/workspace.json` 被覆盖 | 本机原有会话从界面「消失」（文件还在） | **合并**：云端独有工作区补进来、会话 id 取并集、置顶取并集，改前备份 `workspace.json.bak-<时间戳>` |
| 严格镜像（`syncPrune`）删本机多余文件 | 直接删除，找不回 | **只挪进回收站** `<插件目录>\trash\<时间戳>\pruned-<目录>\`，保留最近 3 批 |

额外的两条硬保护：

- 云端这次一个文件都没取到（下载失败 / 云端目录空）时，严格镜像**整段跳过**并打 `[warn] 云端这次没有取到任何文件，为防误删本机数据，已跳过严格镜像删除`。
- 上传侧的云端删除同理：本机这次读到 0 个文件、或要删的比留下的还多时，只警告不删云端；确认无误要重跑并加 `--force`。

`storages/session_projcache` 是本机会话归属缓存，云端的不覆盖已有文件。

冲突时日志长这样（前 20 条逐条打印，末尾给总数）：

```text
[conflict] 本机这份更新，保留本机：sessions/abc/session.v4.jsonl.zstd（云端旧版放进回收站）
[warn] 有 3 个文件本机版本更新，已全部保留本机（云端旧版在回收站）
```

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
| `syncPrune` | `false` | 严格镜像：拉取时把本机多余文件挪进回收站（不再直接删） |
| `syncIdleMinutes` | `10` | 同步「无输出」超时（分钟，0 = 关）；超时就中止，避免一直「同步中」 |
| `syncMaxMinutes` | `180` | 同步总时长上限（分钟，0 = 关） |
| `syncFiles` | `[model, plugins]` | 装配文件：`model` / `plugins` / `credentials`（凭据默认不勾） |
| `credentialsEnvelope` | `false` | 开「密钥信封」：凭据加密成 `.credentials.yaml.enc` 上传（云端只有密文，需同一个口令还原，见 §5.3） |
| `workspaceRemap` | `true` | 拉取后自动重映射工作区路径（见 §5.5） |
| `workspaceMap` | 空 | 手动映射，一行一条 `原前缀=>新前缀`（如 `D:\Code=>C:\Work\Code`） |
| `syncProfileExclude` | 空 | 不同步的 profile 名，逗号分隔（如 `abtest, tmp`） |
| `syncProfile` | 空 = 自动 | 装配文件用哪个 profile 名；新机器 profile 还没建时也可填 |
| `stagingDir` | 空 = `D:\DSH-Backup`（存在时）否则 插件目录 `staging` | 包与解包临时区 |
| `keyFile` | 空 = `staging\KEY.txt` | 本机口令文件 |
| `restoreDir` | 空 = `staging\restore\<包名>` | 解包输出目录 |
| `aliyunpanExe` | 空 = 自动探测 | CLI 路径（自举安装会写这里） |
| `aliyunpanUrl` | 空 = GitHub 官方发布 | 自举安装的自定义下载地址（镜像 / 内网文件服务器，必须 http(s) 且指到压缩包）；只想用本地包时留空，在配置页点「从本地安装」 |

配置存放在 `~/.dsh/dsh-aliyunpan-backup/config.json`（可用 `DSH_AB_HOME` 改插件数据目录、`DSH_AB_CONFIG` 直接指定配置文件）。

---

## 8. HTTP 路由（21 条，全部 exact + 仅 loopback）

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
| `/sync/log` | GET | 同步日志尾巴：`?lines=`（10…2000，默认 200）→ `{ok,path,lines,requested,text,bytes,state}` |
| `/provision` | GET | aliyunpan 运行环境 + 安装状态与日志 |
| `/provision/run` | POST | 自举安装（`{url}` 覆盖下载地址、`{tag}` 指定版本、`{local}` 用本地 zip/目录安装） |
| `/pick` | POST | 弹系统选择框：`{kind, initial, title}`（kind = `dir` 或 `file`）→ `{ok, path}`；取消/超时 409 |
| `/update` | GET | 自更新状态；`?check=1` 会去查一次上游（不传时首次访问也会顺手查一次） |
| `/update/run` | POST | 开始更新，`{profile}` 可选；已在更新时 409 |
| `/login` | GET | 阿里云盘账号状态（`account.ok/nick/uid/drive`）+ 登录进度（`phase`、授权 `url`、日志） |
| `/login/start` | POST | 起后台 `aliyunpan login`（授权链接稍后出现在 `/login.url`）；已在登录时 409 |
| `/login/confirm` | POST | 往登录子进程敲回车（浏览器授权 + APP 扫码之后）；没拿到链接时 409 |
| `/login/cancel` | POST | 取消登录；没有进行中的会话时 409 |

---

## 9. 安全

- **同步是明文**：云端目录可以直接打开看。会话与附件里有隐私内容，介意就别同步这些目录。
- **口令只在本机**：`KEY.txt` 不随同步上传（它在插件数据目录，不在同步白名单里）。丢了口令，旧包与密钥信封就永久打不开。
- **凭据建议走密钥信封**（§5.3）：`credentialsEnvelope: true` 时云端只有 `.credentials.yaml.enc`，明文 `.credentials.yaml` 不会被上传；不开信封又勾「登录凭据」则是明文上云。
- 信封是 AES-256-GCM + scrypt(N=32768)，能防「云盘被别人看到」，不能防「口令也被拿到」。口令别和备份放在同一个盘里。
- `KEY.txt` 写入用 `mode: 0o600`，但 **Windows 忽略 POSIX 权限位**，实际靠 `%USERPROFILE%` 的目录 ACL 保护。
- 日志只记路径、文件数、耗时、退出码，不记口令与文件内容。
- **拉取不会删本机数据**：本机更大的文件不覆盖；严格镜像只把文件挪进 `<插件目录>\trash\`（保留 3 批），随时能手动还原；云端这次没取到文件时整段跳过。
- **工作区索引合并而不是覆盖**：`storages/workspace.json` 合并会话归属、改前备份 `.bak-<时间戳>`，本机原有会话不会从界面消失。
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

**Q：另一台机器点「从机拉取」，11 个根全是「云端还没有这个目录/文件，跳过」？** 先看配置页「阿里云盘账号」是不是「已登录」且昵称/UID 与主机一致 —— 没登录时 `aliyunpan download` 会 panic，旧版本会把它当成「云端没有」静默跳过（0.5.1 起直接报错 `exit 4`）。账号没问题再核对同步目录名（`syncDir`）和主机是否真的上传过。

**Q：从机拉取后工作区全打不开 / 路径无效？** `workspace.json` 里存的是绝对路径，换机后原路径不存在。0.5.4 起拉取结束会自动改：先试你的「工作区路径映射」，再试换盘符、`Documents\<目录名>`、`<用户>\<目录名>`，只改 `exists()` 为真的；改前备份成 `workspace.json.bak-<时间戳>`，改不动的原样保留并在日志里 `[warn]`。

**Q：还要备份加密包吗？** 0.4.0 起不做打包上传了。要异地留档：同步一份明文，或自行打包后传到云盘再解码。

---

## 11. 开发与测试

```powershell
node --check lib/index.js      # 宿主半侧
node --check lib/client.js     # 浏览器半侧
node test/smoke.mjs            # 路由/配置/UI/客户端组件断言（21 条路由 + 装配文件根 + 登录接口 + 看门狗）
node test/safety.mjs           # 6 条数据安全用例：不覆盖本机更完整的记录 / 工作区合并 / 回收站 / 云端为空不删
node test/e2e.mjs              # 造一个真实加密包 → 校验 → 错口令 → 解包 → 逐字节比对
```

目录：

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 宿主半侧：21 条路由 + 配置读写 + 口令 + 系统选择框 + 日志尾巴 |
| `lib/client.js` | 设置卡片：同步上传 / 从机拉取 / 内嵌完整页 |
| `lib/config.mjs` | 默认值、白名单、路径解析、`aliyunpan` 探测 |
| `lib/provision.mjs` | 自举安装：查发布、挑包、下载（重试 + 镜像回退 + 本地包）、校验、解压、试跑、写配置 |
| `lib/runner.mjs` | 解码任务：解析包路径、起子进程、日志/状态 |
| `lib/syncplan.mjs` | 预演统计 |
| `lib/syncrun.mjs` | 同步任务进程管理：输出心跳、无输出/总时长看门狗、孤儿进程识别 |
| `lib/scripts/restore.mjs` | 解密 / 校验 / 解包 |
| `lib/scripts/syncd.mjs` | 同步执行体（plan/upload/download） |
| `lib/ui.html` | 完整配置页（单文件） |
| `test/safety.mjs` | 数据安全用例（镜像保护、回收站、工作区合并） |
| `test/fixtures/make-package.mjs` | 按 0.3.x 格式造包（加密） |

---

## 12. 变更记录

### 0.6.3

- **修「看门狗做了但界面看不见」**：/status 只下发 sync.running / sync.last，把 job / orphan / runningSec / idleSec / timeout 全丢了 —— 所以 0.6.0 的卡住判定、重启后的「上次中断」、孤儿进程提示在插件卡里根本不显示，用户只能看到「同步中」永远不动。现在这五个字段一起下发，卡片能显示「已运行 N · 最近输出 M 前」并在卡住 / 中断 / 有孤儿进程时直接给红字和「结束任务 (pid N)」按钮。
- **修「上次同步 · files=undefined」**：状态文件里没有顶层 files 字段（真实结构是 results[]），旧代码直接读 last.files → 界面永远显示 undefined。改成累加 results[].files，文案变「上次同步 <时间> · N 个文件」；同时兼容少数多包一层 last 的旧状态文件，没有 at 时干脆不显示这一行（交给徽标说「未同步」）。
- 验证：在隔离实例（临时 DSH_AB_HOME + 假 sync-job.json）里用 headless Edge 走真实 GUI —— 插件卡显示红字「上次的同步进程（pid …）在宿主重启后还活着」+「结束任务 (pid …)」，点「运行日志」拉到 83 行 / 4.4 KB 并把日志渲染在卡片内；完整配置页默认只露 3 张卡（账号 / 同步 / 介绍），显示全部设置 放出另外 6 张，高级设置 与 运行日志 折叠默认收起，容器宽 1100 px 时 scrollWidth == clientWidth（无横向溢出）。

### 0.6.2

- **修 `--prune` 在「没有文件变化」时完全不删云端**：`uploadOne()` 在 `changed.length === 0` 时提前 return，云端删除那段代码根本走不到 → 本机删掉的旧文件会永远留在云端，界面还显示「无变化，跳过」。现在把云端删除抽成 `pruneRemote()`，无变化分支也调用一次。真机复现：25 个文件上传后删到 3 个，旧版 `--prune` 云端仍是 25 个；0.6.2 一次 `--prune` 就按闸门拦住（23 > 3），加 `--force` 后云端降到 3 个。
- 防误删闸门依旧生效：要删的比留下的多（>20 且多于剩余数）或本机一个文件都没读到，只打印警告不删。

### 0.6.1
- **下载失败时给出可执行的线索**：`aliyunpan` 在暂存目录里连 `mkdir` / 建文件都被拒（`Access is denied`，常见于安全软件拦子进程写盘）时，原来只报「下载没有拿到任何文件（退出码 0）」，看不出原因。现在 `examineMiss()` 识别该错误并追加两行提示：说明是写盘被拦，并把「下载暂存目录」改到允许的位置或给 `aliyunpan.exe` 加信任。
- 真机复现记录：`%TEMP%\…` 下的暂存目录被拦（`mkdir …\DeepSeek Harness: Access is denied`），同一命令换到 `D:\Code\…` 立即成功 → 属于环境限制，不是插件逻辑错；0.6.1 起日志能直接指出来。

### 0.6.0
- **修「一直同步中」**：`lib/syncrun.mjs` 给子进程输出打时间戳当心跳，`judgeStall()` 两个阈值——无输出 `syncIdleMinutes`（默认 10 分钟）、总时长 `syncMaxMinutes`（默认 180 分钟），超时杀进程并把 `stalled` 原因写进 `sync-job.json`；重启后状态文件停在 running 但 pid 已死时，识别为 `interrupted` 并暴露 `state.orphan = {pid}`，卡片给「结束任务」按钮。
- **可诊断的日志**：新增 `/sync/log?lines=`（10…2000）路由；界面里卡片有「运行日志」面板（刷新 / 加载更多 / 复制），完整配置页有「运行日志」折叠区；`/sync` 也带 200 行尾巴与 `timeout` 配置。日志每行带时间戳，同步中还能看到「已运行 N · 最近输出 M 前」。
- **页面精简**：默认只显示账号 + 同步两张高频卡，「显示全部设置」开关放出低频卡（运行环境 / 插件更新 / 解码本地包 / 口令 / 路径配置 / 解码日志）；同步卡低频字段收进「高级设置」折叠区。同步卡改成 `minmax(0,1fr)` 栅格 + `pre-wrap` 日志，窄到 500 px 也不横向溢出。
- **拉取绝不弄丢本机记录（重点修复）**：旧逻辑「size 变就覆盖」，DSH 会话是追加写，本机更长的那份会被云端旧版盖掉。现在本机文件更大时一律保留本机、云端版本进回收站；`storages/workspace.json` 改成合并（云端独有工作区补入、会话 id 并集、置顶并集，改前 `.bak-<时间戳>`）；`syncPrune` 从 `unlinkSync` 改成挪进 `trash/<时间戳>/pruned-<目录>/` 且云端空取时整段跳过；上传侧云端删除也加了「本机读到 0 个 / 要删比留下多」的防误删闸门（`--force` 才强删）。
- 新增 `test/safety.mjs`（6 条用例：本机更大时保留、云端更大时更新、工作区合并、云端为空不删、严格镜像进回收站、会话缓存不被覆盖）；`syncd.mjs` 支持 `DSH_AB_SYNCD_IMPORT=1` 被 import（不触发云盘调用）。smoke 扩到 21 条路由 + 看门狗/孤儿进程断言。

### 0.5.4

- **拉取后自动重映射工作区路径**：`storages/workspace.json` 里的绝对路径（`D:\Code\…`）换机后不存在，DSH 工作区全空。新增 `lib/workspace.mjs`（`parseMap` / `candidatesFor` / `planRemap` / `applyRemap` / `remapWorkspaces` / `workspaceSummary`），候选顺序：手动前缀映射 → 换盘符 → `Documents\<目录名>` → `<用户>\<目录名>`，只采纳 `exists()` 为真的；改前备份 `workspace.json.bak-<YYYYMMDDTHHMMSS>`，报告写 `workspace-remap.json`，`sync-state.json` 的 `workspace` 记 `{remapped,unresolved,backup,error}`。
- **不同步的 profile**（`syncProfileExclude`）：逗号/分号/空格分隔最多 20 个名字，`profileNames()` 过滤掉它们，测试 profile 不再传染到别的机器。
- 新配置 `workspaceRemap`（默认 true）/ `workspaceMap`（`原前缀=>新前缀`，也认 `->`，`#` 注释）/ `syncProfileExclude`；`/status` 与 `/sync` 都暴露 `workspace: {file,total,missing,remap,mapRules,last}`；配置页「同步」卡新增勾选框 + 两个输入框 + 一行状态（「本机工作区 N 个 · 其中 M 个路径不存在 · 上次重映射 X 个」）；插件卡新增「工作区」一行。
- 实测（真云盘，临时 home + 临时云目录）：上传一份含 `Z:\…` 的 workspace.json（296B）→ 删本机文件 → `--mode download` 打出 `[info] 工作区「测试」路径：Z:\Code\deepseek\cs → D:\Code\deepseek\cs（手动映射 Z:\Code => D:\Code）`、`[warn] 工作区「无解」本机不存在：Z:\Nope\zzz` + hint、`[info] 已改 1 个工作区路径；原文件备份：…\workspace.json.bak-20261028T030202`，回读 w1 已改写、w2 原样、`title`/`sessionIds` 保留，`sync-state.json` 的 workspace 为 `{"remapped":1,"unresolved":1,…}`。本机真实 6 个工作区路径都存在，所以在本机跑不改任何路径。smoke 增加 `parseMap` / `planRemap` 4 用例 / `remapWorkspaces` 集成（含二次运行 remapped=0）/ `/status.workspace` / `profileExcludeList` 断言（`routes=20` 不变）。
- 顺手清理云端测试残留：`DSH-Sync/profiles/abtest`、`_last-sync-AB-TEST.json`、`DSH-Sync-test-notexist` 已删（云盘回收站可找回），本机 `profiles/abtest` 也删了。

### 0.5.3

- **密钥信封（可选）**：把 `.credentials.yaml` 用口令加密成单文件 `.credentials.yaml.enc` 再上传，云端只有密文；换机器用同一个口令解出来写回本机。配置页「同步」卡一个勾选框（`credentialsEnvelope`），勾上后明文「登录凭据」自动置灰。
- 新模块 `lib/envelope.mjs`：`seal/open`（magic `DSHKEY01` + salt(16) + nonce(12) + AES-256-GCM tag(16)，scrypt N=32768 r=8 p=1，AAD `dsh-credentials-v1`）、`sealFile`、`openToFile`（内容相同不重写，不同则先备份 `.credentials.yaml.bak-<时间戳>`）、`readPass/hasPass/credentialsPath`。
- `lib/scripts/syncd.mjs`：`ENVELOPE` 开关打开时从 `syncFiles` 里剔除 `credentials`（不留明文副本），新增 `uploadEnvelope()` / `downloadEnvelope()`（索引按 size+mtime 比对，未变不重传；拉取走 `download --saveto 暂存 --ow -p 1` 再解密）；plan 与 `SYNC RESULT` 的 roots 计数 +1。
- `/status` 与 `/sync` 都暴露 `envelope: { enabled, keyReady, keyFile, credentials, credentialsBytes, remotePath }`；`sanitizeConfig` 接受 `credentialsEnvelope` 布尔值；插件卡新增一行「登录凭据：不同步 / 缺口令 / 已开（云端只有密文）」。
- 实测（真云盘，隔离 home）：plan 显示两行；`--mode upload` 上传 `task-board/ledger-v2.json` + `.credentials.yaml.enc`（160B），云端根目录只有密文、没有明文 `.credentials.yaml`；删掉本机凭据后 `--mode download` 解密还原，内容逐字节一致；错口令 → `[fail] 口令不对（或信封被改过），解密失败` + `[hint] 两台机器必须用同一个口令`，exit=4 且不写文件；本机已有不同内容 → 先备份 `.credentials.yaml.bak-20261028T021401` 再覆盖。smoke 增加信封往返/错口令/篡改/备份/`/status.envelope` 断言（`routes=20` 不变）。
### 0.5.2

- **拉取时自动发现云端 profile 名**（回答「没有目录名，不能自己获取吗」）：从机不再假设云端也叫本机那个 profile。下载模式先 `aliyunpan ls <syncDir>/profiles` 拿到云端真实存在的目录名，再拼 `profiles/<云端名>/cordis.patch.yml` 等装配文件的云端路径；本机落点由映射规则决定（同名原样 / 两边都只有一个时 1:1 映射到本机那个 / 其它按云端名新建）。日志会打 `[info] 云端 profile: desktop、web` 和每条的映射说明。
- 不做多对一合并：云端有两个以上 profile 时，如果都塞进本机唯一目录，`cordis.patch.yml` 会被后写的覆盖，看起来「模型同步了但配置不对」。宁可各建各的目录。
- `lib/config.mjs`：新增 `mapProfileName(remoteName, localProfiles, remoteCount)`、`profileTargets(cfg, remoteNames)`；`syncRoots(cfg, { profiles })` 的 profile 文件根多了 `profile` / `localProfile` / `note` 三个字段（`name` 仍是云端相对路径，索引与日志格式不变）。
- `lib/scripts/syncd.mjs`：新增 `remoteProfiles()`（`ls` + 按 `YYYY-MM-DD HH:MM:SS  名字/` 解析，跳过 `_`/`.` 开头），只在 `--mode download` 生效；plan/upload 行为不变。
- 覆盖四种组合的实测（本地 [solo] / 云端 [desktop]、[solo]/[desktop,web]、[desktop]/[desktop,web]、[]/[desktop]）都按上表落地；smoke 增加对应断言（`routes=20` 不变）。
### 0.5.1

- **登录卡**（另一台机器「已拉取，没效果」的直接原因）：那台机器没登录阿里云盘，`aliyunpan download` 直接 panic（`invalid memory address`），旧代码把「命令挂了」当成「云端没有这个目录」静默跳过，于是 11 个根全打印「云端还没有这个目录，跳过」，`files=0 failed=0` —— 看上去像同步没事，其实一个字节都没动。
- 新增 `lib/login.mjs`：把交互式 `aliyunpan login` 包成「后台子进程 + 页面显示授权链接 + 一键回车」。配置页新增「阿里云盘账号」卡：已登录/未登录、昵称与 UID 前 8 位、三个按钮〔登录阿里云盘〕〔我已扫码，继续〕〔取消〕；授权只能走 `openapi.alipan.com` 那条链接（浏览器点「允许」→ 手机 APP 扫码 → 回车）。
- 坑：`aliyunpan login` **失败也返回 0**，所以成功判定只能看输出里的「登录成功」或登录后 `aliyunpan who` 是否 ok；授权链接大约启动 6 秒后才打印，没拿到链接时点「继续」会被拒绝。
- `syncd.mjs` 加登录前置检查：未登录直接 `[fail] 这台机器还没有登录阿里云盘：…` + 登录命令提示、`exit 4`，不再假报成功；下载没产出文件时区分「云端确实没有」（`指定目录不存在`，正常跳过）与「命令失败/panic」（打印输出尾巴 + 提示）；全部根都空时打印三段诊断（账号是否一致 / 主机是否真传上去 / 云端目录名是否一致）。注意 `aliyunpan ls` 对不存在的目录**退出码仍是 0**，不能用退出码判断。
- 路由 16 → 20（`/login`、`/login/start`、`/login/confirm`、`/login/cancel`）；设置页插件卡多一行账号状态，未登录时多一个〔去登录〕按钮（直接展开内嵌配置页）。

### 0.5.0

- **插件内自带更新按钮**（用户提的「插件里面要有更新按钮」）：不用再去命令行或插件市场，卡片上直接「更新插件到 x.y.z」，完整配置页多了「插件更新」卡（当前版本 / 磁盘版本 / 上游版本 / 安装位置 / 实时日志）。
- 更新实现不依赖 pnpm：下载 GitHub 源码 tarball → 解压 → 整目录原子替换（旧目录先改名 `.old-<时间戳>`，失败自动回滚），下载复用 0.4.4 的「官方直连 → ghfast.top → gh-proxy.com」+ 每源 2 次重试；`link:` 安装改走 `git pull --ff-only`。
- 版本查询四级兜底：GitHub API（`contents` + raw accept）→ `raw.githubusercontent.com` → 两个镜像；全挂时给出逐条失败原因，不会假装「已是最新」。
- 更新完成后明确提示「重启 DSH 生效」，不做自动重启（重启会掐掉正在跑的同步）。
- 路由 14 → 16（`/update`、`/update/run`）；测试环境变量 `DSH_AB_NO_UPDATE_CHECK=1` 可关掉首次自动检查（smoke 用它避免打网络）。
- 修：宿主给子进程注入了同一个 `DSH_PROFILE`，导致 `--profile X` 起的实例把别的 profile 当成「正在用」，顺手按错的 profile 判断要不要更新；现在优先用「已加载模块自己的路径」反推（`realDir === SELF_ROOT` → 路径里含 `/profiles/<名>/` → `DSH_PROFILE` → 第一个）。
- 修：更新替换完文件后磁盘版本已经是新版，`pendingRestart` 立刻变 false，界面会显示「已是最新」，用户不知道该重启；现在模块加载时把版本记成 `LOADED_VERSION`，「当前版本」永远显示运行中的那个，`installed > LOADED_VERSION` 才算「重启后生效」。
- 实测：github 安装路径（把已装 0.5.0 的版本号改成 0.4.0 冒充旧版 → 点更新 → 4 秒换完 → `current 0.4.0 / installed 0.5.0 / pendingRestart true` → 重启后 `current 0.5.0`）、link 安装路径（本地 bare remote 造 0.5.1 → `git pull --ff-only` fast-forward → `完成：plink → 0.5.1`）。

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
