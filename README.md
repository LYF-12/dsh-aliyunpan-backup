# dsh-aliyunpan-backup

把 **DeepSeek Harness（DSH）** 的配置、插件装配、会话记录与附件，打包成 **加密快照** 并同步到 **阿里云盘** 的 DSH 插件。
装上之后，**设置 → 插件 → 本插件** 页面里就有一个带图标的配置面板：点一下「立即备份并上传」即可，云端按份数自动滚动清理。

- 一条链路：扫描 → 打包（DSHBUNDLE1 容器）→ AES-256-GCM 分块加密 → 上传阿里云盘 → 回读/逐文件校验 → 清理旧快照
- 加密：口令（KEY.txt）**只在本机**，云端只有密文；换机器还原时把 KEY.txt 一起带过去
- 界面：设置里一个配置卡片 + 一个完整配置页（`/api/dsh-aliyunpan-backup/ui`）
- 宿主半侧只依赖 `webServer` 一个服务，浏览器半侧只 require `react`

---

## 1. 安装

### 1.1 从 GitHub 安装（推荐）

仓库已发布：**https://github.com/LYF-12/dsh-aliyunpan-backup**（Public，main 分支）

在 DSH 里 **设置 → 插件（插件市场）→ 添加插件**，粘贴：

```
github:LYF-12/dsh-aliyunpan-backup
```

也接受固定提交与目录形式：

```
github:LYF-12/dsh-aliyunpan-backup#<commit-sha>
https://github.com/LYF-12/dsh-aliyunpan-backup/tree/main
```

命令行等价写法（已实测，pnpm 直取 tarball，2.7s）：

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop add github:LYF-12/dsh-aliyunpan-backup
```

安装后 **重启 DSH**，在 设置 → 插件 里能看到本插件的图标与配置页。

> 走命令行 `dsh plugin add` 时，profile 的 `dsh.profile.bundles` 不会自动追加本包（实测）；
> 走插件市场「添加插件」则会在安装流程里一并登记 bundle。若用命令行安装且界面没出现，
> 到 `%USERPROFILE%\.dsh\profiles\<profile>\package.json` 的 `dsh.profile.bundles` 数组里补一行
> `"dsh-aliyunpan-backup"` 再重启。

### 1.2 本机源码安装（开发用，已实测）

DSH 自带 CLI 就是官方的安装入口，它会把包写进 profile 的依赖并追加到该 profile 的 bundle 层：

```powershell
# DSH 安装目录下的 runtime\cli\bin\dsh.cmd
& "C:\Users\<你>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop add link:D:\Code\deepseek\cs\dsh-aliyunpan-backup
```

实测输出：`+ dsh-aliyunpan-backup 0.1.0 <- D:\Code\deepseek\cs\dsh-aliyunpan-backup`，
profile 的 `dsh.profile.bundles` 自动追加 `dsh-aliyunpan-backup`。装完**重启 DSH**生效。

> 注意：DSH 内置插件管理器的 update/install 对「已在 profile 里声明」的包会返回 `already-installed`（上游问题）。
> 手动升级请用上面的 bundled pnpm，并把目标版本追加进 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`。

### 1.3 改完代码怎么再推上去

远端 = `origin` → https://github.com/LYF-12/dsh-aliyunpan-backup.git，已配好 Git 凭据管理器（GCM），
本机凭据已存（`LYF-12`），直接：

```powershell
cd D:\Code\deepseek\cs\dsh-aliyunpan-backup
git add -A; git commit -m "your change"; git push
```

> 本机实测 `github.com:443` 时通时不通（api.github.com 一直通）。若 `git push` 报
> `Could not connect to server` / `Connection timed out`，重试即可；实在不通时可走
> GitHub REST 的 Git Data API 提交（blobs → trees → commits → refs）。

---

## 2. 依赖：aliyunpan CLI

上传/下载走社区 CLI **aliyunpan**（v0.4.x，作者 tickstep），它复用你自己的阿里云盘登录态，插件本身不保存任何网盘令牌。

1. 下载 `aliyunpan.exe`（Windows x64/arm64 均可）放到任意目录，例如 `D:\Tools\aliyunpan\aliyunpan.exe`
2. 在该目录执行一次 `aliyunpan login`：终端会打印一个 **5 分钟内有效**的链接，浏览器里点「允许」后回到终端按一次回车
3. `aliyunpan who` 能看到 UID / 昵称即成功（客户端里的登录态与 CLI 是两套，必须单独登一次）

插件按这个顺序找 `aliyunpan`，换一台 Windows 机器不用改代码：

1. 配置页里手填的「aliyunpan 可执行文件」
2. 遗留路径：本机以前放过的位置（存在才用，不存在跳过）
3. 插件数据目录：`%USERPROFILE%\.dsh\dsh-aliyunpan-backup\aliyunpan.exe`
4. 常见安装位置：`%LOCALAPPDATA%\Programs\aliyunpan\`、`C:\Program Files\aliyunpan\`
5. **PATH**：任何已在 `PATH` 里的 `aliyunpan.exe`（最省事：装好后命令行能直接敲 `aliyunpan` 就行）

每台机器都要各自 `aliyunpan login` 一次（登录态不跟备份包走）。

---

## 3. 界面

| 位置 | 内容 |
| --- | --- |
| 设置 → 插件 → 本插件（官方 keyed 席位 `plugins.bundle.config`） | 状态徽标（运行中 / 上次成功 / 上次失败）、最新快照、**立即备份并上传 / 只打包校验 / 取消 / 刷新 / 打开完整配置页 / 复制配置页地址**。配置页在卡片内**内嵌 iframe** 展开（宿主里 `target=_blank` 会被弹窗策略拦掉，所以不再开新标签） |
| 完整配置页 `/api/dsh-aliyunpan-backup/ui` | 配置表单、本地快照列表（逐份校验 / 解包）、实时运行日志 |

配置项：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `remoteDir` | `/DeepSeek Harness/DSH-Backup` | 云端目录（快照落在其下的 `snapshots/`） |
| `stagingDir` | `D:\DSH-Backup`（不存在则用插件数据目录） | 本地暂存：快照 + `KEY.txt` + 最近一次日志 |
| `keep` | `3` | 云端保留份数，`0` 表示不清理 |
| `aliyunpanExe` | 自动探测 | aliyunpan 可执行文件路径 |
| `dshHome` | `%USERPROFILE%\.dsh` | 要备份的 DSH 数据目录 |
| `keyFile` | `<stagingDir>/KEY.txt` | 口令文件；首次运行自动生成 24 位随机口令；换机器时用配置页的「口令」卡片粘贴旧口令 |
| `includeFeishuFiles` | `false` | 是否收录 `feishu\files`（收到的文档/压缩包，约 +270MB） |
| `includeCredentials` | `false` | 是否收录 `.credentials.yaml` / `.npmrc`（登录凭据）；默认不收，换机后重新登录 |
| `restoreDir` | 空 | 「解包」输出目录；留空 = `<stagingDir>\restore\<快照名>` |

配置保存在 `%USERPROFILE%\.dsh\dsh-aliyunpan-backup\config.json`（可用环境变量 `DSH_AB_HOME` 改数据目录）。

---

## 4. 备份了什么

| 采集 | 规则 |
| --- | --- |
| `.dsh` 根级文件 | 全收（`pet.json`、设置等普通文件） |
| `storages` / `task-board` / `feishu` / `eda` / `skins` / `sessions` / `attachments` | 全收 |
| `pets` | 只收 `.json` |
| `profiles` | 只收 profile 根级：`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`cordis.patch.yml`、`*.patch.yml*`、`.npmrc` 与小配置 |
| `sources` | 只收 ≤2 层小配置 |
| 跳过 | `node_modules`、`.git`、`dist`、`.pnpm-store`、`cache`、`backups` |

> **凭据（默认不进包）**：`.credentials.yaml`（API key、设备令牌）与 `.npmrc` 默认**不收录**；勾选 `includeCredentials` 才收（仍会 AES-256-GCM 加密）。换机还原后按提示重新登录即可。
>
> **每次都是全量快照**：不做增量（否则跨版本/跨机恢复容易残缺），所以每次约 215MB（不含飞书文件）/ 486MB（含）；云端保留最近 `keep` 份，旧包自动删除。

**实测体积**（2026-10-26，本机）：不含飞书文件约 215MB，含则约 486MB；上传约 5MB/s、下载约 0.4MB/s。

### 4.1 只想同步「另一份内容」怎么办

现在能调的维度（都在配置里，不用改代码）：

| 想做的事 | 怎么配 |
| --- | --- |
| 不收飞书文件（省 270MB） | `includeFeishuFiles=false`（默认） |
| 连登录凭据一起带走 | `includeCredentials=true` |
| 备份另一台机器 / 另一个 `.dsh` | 改 `dshHome` 指向那个目录 |
| 放到网盘另一个位置 | 改 `remoteDir`（会自动在其下建 `snapshots/`） |
| 本地留更多/更少份数 | `stagingDir` + 手工清理；云端份数用 `keep` |

**暂时不支持**按模块逐项勾选（比如「只要会话不要附件」）——采集规则固定在 `lib/scripts/build.mjs` 的 `INCLUDE_DIRS` / `SKIP_DIRS`，要改成自定义清单得改代码。

### 4.2 多套方案并存

插件只有一份配置，但可以起两个独立实例（不同数据目录 + 不同云端目录）互不干扰：

```powershell
$env:DSH_AB_HOME = "C:\Users\LYF\.dsh-backup-b"   # 各自的 config.json / KEY.txt / staging
```

不过同一台机器上通常没必要，`keep` 已经能保留历史版本。

---

## 5. 包格式

```
DSHBUNDLE1\n + u32 条目数 + [u32 名长][名][u64 大小][数据]…   # 首个条目固定 manifest.json（含每文件 sha256）
```

加密（`payload.enc`）：

```
'DSHBK002'(8) + salt(16) + noncePrefix(4) + u64 plainBytes        # 36 字节头
key = scrypt(口令, salt, 32, N=32768, r=8, p=1)
1MiB 分块：nonce = noncePrefix(4)+块号(4)+0(4)，AAD = "dshbk-chunk-<i>"，每块 tag(16)+密文
```

`payload.enc` 旁边有 `package.info.json`（文件数、原始字节、bundle 字节、密文 sha256 等，**不含口令**）。

---

## 6. 还原

界面里「本地快照 → 校验 / 解包」即可；命令行等价：

```powershell
# 只校验（解密 + 逐文件 sha256）
node lib/scripts/restore.mjs --pkg "D:\DSH-Backup\snapshots\20261026T1512-full" --key "D:\DSH-Backup\KEY.txt" --verify-only

# 解包到指定目录
node lib/scripts/restore.mjs --pkg "D:\DSH-Backup\snapshots\20261026T1512-full" --key "D:\DSH-Backup\KEY.txt" --out "D:\restore-test"
```

界面里「解包」默认落到 `D:\DSH-Backup\restore\<快照名>`（可在配置里改 `restoreDir`），**不会直接覆盖 `.dsh`**——先看内容，再手工挑需要的目录复制回 `C:\Users\<你>\.dsh`。

### 6.1 换电脑还原（0.2.0 起不用手拷 KEY.txt）

**要带过去的只有一样东西：口令**（旧机器 `KEY.txt` 里那串字符）。云端 `payload.enc` 是 AES-256-GCM，没有口令谁也解不开，插件也救不回来。

1. **旧机器**：配置页 →「口令」→ 点「显示口令」或「复制口令」→ 存进密码管理器 / 离线记录
2. **新机器**：安装插件（见 §1.1）→ `aliyunpan login` → 配置页确认云端目录仍是 `/DeepSeek Harness/DSH-Backup`
3. **新机器**：配置页 →「口令」→ 输入框粘贴旧口令 → 点「使用此口令」（写入本机 `KEY.txt`）
4. 取回快照（名字必须与云端 `<id>` 一致）：

```powershell
aliyunpan ls "/DeepSeek Harness/DSH-Backup/snapshots"
aliyunpan download --saveto "%USERPROFILE%\.dsh\dsh-aliyunpan-backup\staging\snapshots" "/DeepSeek Harness/DSH-Backup/snapshots/20261026T1512-full"
```

5. 插件界面「本地快照」里点「校验」→ 出现 `verify: ok=N bad=0` 说明口令与包匹配；再点「解包」

命令行等价（把路径换成你自己配置页显示的暂存目录）：

```powershell
node lib/scripts/restore.mjs --pkg "<staging>\snapshots\20261026T1512-full" --key "<staging>\KEY.txt" --verify-only
node lib/scripts/restore.mjs --pkg "<staging>\snapshots\20261026T1512-full" --key "<staging>\KEY.txt" --out "D:\restore-20261026"
```

**多台机器共用一个云端目录时**：`keep` 是全局份数（不是每台各算），后来的备份会按顺序挤掉最早的；机器多了把 `keep` 调到机器数 ×2 以上，或者干脆设 `0` 不清理。逆序还原永远是「下载想要的 `<id>` 那一份」，不受影响。

**新机器上暂存目录默认在哪？** 老机器若用过 `D:\DSH-Backup` 且该目录存在才沿用它；否则是插件数据目录 `%USERPROFILE%\.dsh\dsh-aliyunpan-backup\staging`。两处都在配置页「本地暂存目录」里显示，别写死。

---

## 7. 安全边界

- 口令只存本机 `KEY.txt`（建议离线备份一份；**丢了密文无法恢复**）
- 配置页「显示口令 / 复制口令」走宿主 loopback 接口，非本机请求一律 403；口令明文不会写进日志、不会进备份包
- Windows 忽略 POSIX 权限位（`0o600` 实际不生效），`KEY.txt` 的隔离依赖 `%USERPROFILE%` 目录自身的 ACL（默认只有本用户可读），别把它拷到共享盘
- 宿主接口只接受 **loopback** 请求，非本机一律 403
- 配置写入走字段白名单
- 插件不保存阿里云盘令牌，网盘登录态由 `aliyunpan` 自己持有
- 日志只落本机 `<stagingDir>/last-run.log`，不含口令

---

## 8. 开发

```powershell
node test/smoke.mjs     # 宿主 8 条路由 + 浏览器半侧（vm 里加载 client.js，替身 react）
node test/e2e.mjs       # 真跑一遍：打包 → 加密 → 校验 → 读日志 → 恢复校验
```

目录：

```
lib/index.js        宿主半侧（name / inject:["webServer"] / apply → 8 条 exact 路由）
lib/client.js       浏览器半侧（只 require react；挂 plugins.bundle.config 官方配置卡 + plugins.detail.section 详情区）
lib/ui.html         完整配置页
lib/config.mjs      配置读写 / 路径解析
lib/runner.mjs      子进程任务（spawn、日志、状态）
lib/scripts/*.mjs   build / restore / sync（也可独立运行）
test/               smoke.mjs、e2e.mjs
```

---

## 9. 常见问题

**Q：安装后设置里看不到？** 重启 DSH。插件是 bundle 层，运行中的进程不会热插拔。

**Q：点「立即备份」报找不到 aliyunpan？** 在配置页填绝对路径；并确认 CLI 已单独 login 过（客户端登录不算）。

**Q：想只备份不清理云端？** 把 `keep` 设为 `0`。

**Q：想更小的包？** 保持 `includeFeishuFiles = false`（默认），并把 `stagingDir` 放在空间充足的盘。

**Q：清理旧快照会真删吗？** `aliyunpan rm` 是移进回收站，可找回。

**Q：换另一台电脑要带走什么？** 只带口令 + 网盘账号：插件从 GitHub 装，快照从云端下，`.dsh` 本身不用拷。流程见 §6.1。

**Q：口令忘了 / `KEY.txt` 丢了？** 云端快照就永久解不开了（AES-256-GCM，无后门）。要么从旧机器再复制一次，要么从你自己的密码记录里找；都没有就只能重新开始备份。所以第一次生成口令后请立刻存一份到密码管理器。

**Q：新机器点「校验」报「口令文件不存在」？** 这是 0.2.0 有意加的前置检查。去配置页「口令」粘贴旧口令即可，别去改 `keyFile` 路径。

**Q：为什么以前备份里 `profiles\<名字>\` 是空的？** 0.1.x 的采集规则只收 `profiles\` 根级文件，插件装配（`cordis.patch.yml`、`package.json`、锁文件）实际没进包；0.2.0 已修，现在会收 `profiles\<名字>\` 下的配置类文件（`node_modules` 仍排除）。

---

## 10. 变更记录

**0.2.1（2026-10-26）— 口令与路径的安全兜底**
- 修：设了 `DSH_AB_HOME`（隔离实例/多实例）时不再复用 `D:\DSH-Backup` 旧路径，避免串机、串口令
- 换口令前自动把旧口令存成 `KEY.txt.bak`，`/key` 状态里返回 `backupFile` / `backup`

**0.2.0（2026-10-26）— 换机可用性**
- `aliyunpan` 按 配置 → 遗留路径 → 插件数据目录 → 常见安装位置 → **PATH** 探测，换机器不用改代码
- 配置页新增「口令」卡片：显示 / 复制 / **粘贴旧机器口令** / 生成新口令；「校验」「解包」前若口令文件缺失直接给出可读错误
- 修：`profiles\<名字>\` 下的配置类文件以前完全没进包（插件装配会丢），现在会收，`node_modules` 仍排除
- 修：新机器暂存目录不存在时，子进程 `spawn` 的 `cwd` 无效导致任务静默失败（现在先建目录）
- 修：`restore` 用配置里的 `keyFile`，不再硬编码 `<staging>\KEY.txt`
- 修：解包按 `\` 与 `/` 两种分隔符归一化，包内路径不会再被压平成文件名
- 路径解析统一遵循 `DSH_AB_HOME`；子进程只拿到 `DSH_AB_CONFIG` 时也能反推出正确数据目录

**0.1.2** 配置页改为卡片内嵌 iframe（宿主拦住 `target=_blank`，点「打开完整配置页」原先没反应），并加「复制配置页地址」

**0.1.1** 「解包」补 `--out`（原先按钮必失败）；默认不收录 `.credentials.yaml` / `.npmrc` 等凭据

**0.1.0** 首个版本：打包 → AES-256-GCM → 上传 → 校验 → 按份数清理

---

## License

MIT © 2026 LYF
