# dsh-aliyunpan-backup

把 **DeepSeek Harness（DSH）** 的数据同步到 **阿里云盘** 的 DSH 插件：会话、附件、工作区索引、任务板等目录**逐目录增量镜像**，一台主机推、多台从机拉。

> 图文版使用说明（含流程图）：[`docs/usage.html`](docs/usage.html)

顺手还带一个**解码器**：本地或别人分享的 `payload.enc` 备份包，可以校验完整性、解包落盘。

- 同步是**明文镜像**：云端就是原始目录树，不用口令，能直接在网页版云盘里看/下载（见 §5）
- 解码只处理加密包：口令（KEY.txt）**只在本机**，云端只有密文；解别人分享的包时在页面里临时填对方的口令即可（见 §6）
- 界面：设置 → 插件 → 本插件里一个配置卡片；另有完整配置页 `/api/dsh-aliyunpan-backup/ui`
- 宿主半侧只依赖 `webServer` 一个服务，浏览器半侧只 require `react`

---

## 1. 能力边界

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 逐目录增量同步到阿里云盘 | 可用 | 一主多从；上传/拉取都做增量比对 |
| 拉回另一台机器的改动 | 可用 | 先下到暂存目录，再由 Node 逐文件比对，**不覆盖正在运行的 DSH** |
| 校验加密包完整性 | 可用 | `payload.enc` 任意位置，按 manifest 逐个 sha256 |
| 解包加密包 | 可用 | 默认落到暂存目录，不覆盖 `.dsh`，人工挑回 |
| 按模块勾选同步内容 | 部分 | 从 10 个白名单目录里多选，不能选任意路径 |
| 打包 + 加密 + 上传 | **已移除**（0.4.0） | 上传交给同步链路；旧包仍可解码 |
| 双向实时同步 | 不支持 | 需要手动点「开始同步」，多机靠锁与索引避免互相踩 |

---

## 2. 安装

### 2.1 从前置条件说起：aliyunpan CLI

插件本身不实现阿里云盘协议，它调用官方命令行工具 `aliyunpan`（aliyunpan-go）。先装好并登录一次：

```powershell
# 1) 拿到 aliyunpan.exe（任选其一）
#    - 官方 release 解压到任意目录
#    - 或放进 PATH 里的某个目录
# 2) 登录（会打开浏览器/扫码，凭据存到本机配置目录）
aliyunpan login
# 3) 确认能列目录
aliyunpan ls "/"
```

插件按这个顺序找可执行文件：配置项 `aliyunpanExe` → 几个常见安装位置 → **`PATH` 里每一项**。所以只要 `aliyunpan` 在 PATH 里，什么都不用配。

### 2.2 装插件（官方 CLI）

```powershell
# GitHub 安装（需要能访问 github.com）
dsh plugin --profile desktop add github:LYF-12/dsh-aliyunpan-backup

# 本地开发：直接链到工作副本，改完代码重启即生效
dsh plugin --profile desktop add link:D:\Code\deepseek\cs\dsh-aliyunpan-backup
```

> ⚠ 命令行 `dsh plugin add` 只写 `dependencies`，**不会**自动登记 `dsh.profile.bundles`。检查 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 里有没有 `dsh-aliyunpan-backup`，没有就手动加一行，否则启动时不会被装配。插件市场 UI 安装会自动登记。

装完**重启 DSH**，打开 设置 → 插件，找到本插件即可。

---

## 3. 界面

设置 → 插件 → 本插件是一张卡片：状态徽标、上次结果、四个按钮。

| 按钮 | 作用 |
| --- | --- |
| 同步上传 | 把本机选中的目录推到云端（增量） |
| 从机拉取 | 把云端内容拉回本机（增量 + 可选严格镜像） |
| 刷新 | 重新读状态/日志 |
| 打开完整配置页 / 复制配置页地址 | 卡片里内嵌完整页面；宿主拦弹窗时用复制地址 |

完整配置页（`/api/dsh-aliyunpan-backup/ui`）六张卡：同步、解码本地包、口令、路径配置、日志。

---

## 4. 一次性准备（主机）

1. `aliyunpan login` 登录（每台机器各自登录）。
2. 打开完整配置页，在「同步」卡片勾选要同步的目录（默认 `sessions` / `attachments` / `storages` / `task-board`）。
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

### 5.2 拉取（云端 → 从机）

```text
# 1) CLI 只负责把云端目录下到暂存区
# 2) Node 再按 size+mtime 逐文件镜像进 .dsh
aliyunpan download --saveto <暂存目录> --ow -p 3 <云端目录>
```

**不让 CLI 直接写 `.dsh`** 的原因有两条：CLI 会自作主张多建一层 `DeepSeek Harness\DSH-Sync\` 目录；而且要逐文件比对才能做到「只写变化的部分」。所以先用 CLI 下到 `syncDlDir`，再由 Node 复制。

- 默认**只增不删**：本机多出来的文件保持原样。
- `syncPrune` 打开 = 严格镜像，会删本机多余文件。**先确认再开。**
- 拉取前请先退出 DSH：正在运行的应用握着会话文件，Windows 上写盘会被拒。

### 5.3 多机与锁

- 每台机器写入 `_last-sync-<机器名>.json`，借此判断「另一台机器最近是否同步过」。
- `syncLockMinutes`（默认 60）内有其它机器活动时：默认只**告警**继续，`--strict` 下直接退出。
- 两台机器同时上传同一批文件没有合并逻辑：**约定一台主机推、其它只拉**最省事。

### 5.4 三个坑

1. `Access is denied` / 暂存目录被拦 → 安全软件拦了 `aliyunpan.exe` 写盘。日志会打 `[hint]`，把 `syncDlDir` 换到允许的目录，或给 exe 加白。
2. 不要用 `aliyunpan sync start`（CLI 自带同步）。它自己维护状态、和本插件的索引互相打架，行为不可预期。
3. 先退出 DSH 再拉取，否则 `ledger-v2.lock` 之类的锁文件写不进去。

### 5.5 命令行等价物

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
| `stagingDir` | 空 = `D:\DSH-Backup`（存在时）否则 插件目录 `staging` | 包与解包临时区 |
| `keyFile` | 空 = `staging\KEY.txt` | 本机口令文件 |
| `restoreDir` | 空 = `staging\restore\<包名>` | 解包输出目录 |
| `aliyunpanExe` | 空 = 自动探测 | CLI 路径 |

配置存放在 `~/.dsh/dsh-aliyunpan-backup/config.json`（可用 `DSH_AB_HOME` 改插件数据目录、`DSH_AB_CONFIG` 直接指定配置文件）。

---

## 8. HTTP 路由（11 条，全部 exact + 仅 loopback）

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

**Q：同步会不会把我整个 `.dsh` 传上去？** 不会，只传 `syncDirs` 里那几个目录，且跳过 `node_modules`、`.git`、符号链接。

**Q：两台机器同时同步会怎样？** 会互相覆盖。用 `syncLockMinutes` + 一主多从的约定。

**Q：解包会不会覆盖正在用的数据？** 不会。解到独立目录，自己挑。

**Q：还要备份加密包吗？** 0.4.0 起不做打包上传了。要异地留档：同步一份明文，或自行打包后传到云盘再解码。

---

## 11. 开发与测试

```powershell
node --check lib/index.js      # 宿主半侧
node --check lib/client.js     # 浏览器半侧
node test/smoke.mjs            # 路由/配置/UI/客户端组件断言（11 条路由）
node test/e2e.mjs              # 造一个真实加密包 → 校验 → 错口令 → 解包 → 逐字节比对
```

目录：

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 宿主半侧：11 条路由 + 配置读写 + 口令 |
| `lib/client.js` | 设置卡片：同步上传 / 从机拉取 / 内嵌完整页 |
| `lib/config.mjs` | 默认值、白名单、路径解析、`aliyunpan` 探测 |
| `lib/runner.mjs` | 解码任务：解析包路径、起子进程、日志/状态 |
| `lib/syncplan.mjs` | 预演统计 |
| `lib/syncrun.mjs` | 同步任务进程管理 |
| `lib/scripts/restore.mjs` | 解密 / 校验 / 解包 |
| `lib/scripts/syncd.mjs` | 同步执行体（plan/upload/download） |
| `lib/ui.html` | 完整配置页（单文件） |
| `test/fixtures/make-package.mjs` | 按 0.3.x 格式造包（加密） |

---

## 12. 变更记录

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
