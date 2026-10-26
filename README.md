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

插件会自动探测常见路径，也可以在配置页手填「aliyunpan 可执行文件」。

---

## 3. 界面

| 位置 | 内容 |
| --- | --- |
| 设置 → 插件 → 本插件（官方 keyed 席位 `plugins.bundle.config`） | 状态徽标（运行中 / 上次成功 / 上次失败）、最新快照、**立即备份并上传 / 只打包校验 / 取消 / 刷新**、打开完整配置页 |
| 完整配置页 `/api/dsh-aliyunpan-backup/ui` | 配置表单、本地快照列表（逐份校验 / 解包）、实时运行日志 |

配置项：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `remoteDir` | `/DeepSeek Harness/DSH-Backup` | 云端目录（快照落在其下的 `snapshots/`） |
| `stagingDir` | `D:\DSH-Backup`（不存在则用插件数据目录） | 本地暂存：快照 + `KEY.txt` + 最近一次日志 |
| `keep` | `3` | 云端保留份数，`0` 表示不清理 |
| `aliyunpanExe` | 自动探测 | aliyunpan 可执行文件路径 |
| `dshHome` | `%USERPROFILE%\.dsh` | 要备份的 DSH 数据目录 |
| `keyFile` | `<stagingDir>/KEY.txt` | 口令文件；首次运行自动生成 24 位随机口令 |
| `includeFeishuFiles` | `false` | 是否收录 `feishu\files`（收到的文档/压缩包，约 +270MB） |

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

> **凭据**：`.credentials.yaml`（API key、设备令牌）位于 `.dsh` 根级，会随包一起被**加密**上传。若不想让它们离开本机，请把 `dshHome` 指向不含它的目录，或还原后自行剔除。

**实测体积**（2026-10-26，本机）：不含飞书文件约 215MB，含则约 486MB；上传约 5MB/s、下载约 0.4MB/s。

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

跨机器还原：把 `snapshots/<id>/` 和 `KEY.txt` 一起拷过去，先 `--verify-only` 再解包。

---

## 7. 安全边界

- 口令只存本机 `KEY.txt`（建议离线备份一份；**丢了密文无法恢复**）
- 宿主接口只接受 **loopback** 请求，非本机一律 403
- 配置写入走字段白名单
- 插件不保存阿里云盘令牌，网盘登录态由 `aliyunpan` 自己持有
- 日志只落本机 `<stagingDir>/last-run.log`，不含口令

---

## 8. 开发

```powershell
node test/smoke.mjs     # 宿主 7 条路由 + 浏览器半侧（vm 里加载 client.js，替身 react）
node test/e2e.mjs       # 真跑一遍：打包 → 加密 → 校验 → 读日志 → 恢复校验
```

目录：

```
lib/index.js        宿主半侧（name / inject:["webServer"] / apply → 7 条 exact 路由）
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

---

## License

MIT © 2026 LYF
