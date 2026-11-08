# Read-EX

Read-EX 是 [readest/readest](https://github.com/readest/readest) 的一个 fork，专注于**自建 / 第三方云存储同步**：

- **OpenList 原生同步**（新增后端，走 OpenList 的 HTTP API：`/api/auth/login` + `/api/fs/*`）
- **OneDrive 同步**（复用上游 Graph API 实现，改用自建 Azure 应用）
- **WebDAV / S3 / Google Drive / iCloud 同步**（上游已有，保持可用）
- **移除第三方云同步的付费门控** —— 同步到自己的网盘不再需要订阅

其余功能与上游一致。上游为 AGPL-3.0，本仓库同样以 AGPL-3.0 发布，源码即本仓库。

---

## 相对上游的改动

| 文件 | 改动 |
|---|---|
| `src/utils/access.ts` | `CLOUD_SYNC_REQUIRES_PREMIUM = false`，第三方同步全plan可用 |
| `src/services/sync/providers/openlist/*` | **新增** OpenList 后端（client + provider） |
| `src/services/sync/file/providerRegistry.ts` | 注册 `openlist` 后端 |
| `src/services/sync/cloudSyncProvider.ts` | 后端枚举、显示名、syncBooks 自动开启 |
| `src/components/settings/integrations/OpenListForm.tsx` | **新增** OpenList 配置页（含目录浏览器） |
| `src/components/settings/IntegrationsPanel.tsx` | 新增 OpenList 入口行与子页 |
| `src/types/settings.ts`、`src/services/constants.ts` | `OpenListSettings` 与默认值 |
| `src-tauri/tauri.conf.json` | `productName` → `Read-EX`，`identifier` → `com.readex.app`，更新器公钥/地址指向本仓库，`createUpdaterArtifacts: true` |
| `.github/workflows/build-desktop.yml` | **新增** 三平台打包工作流（并移除上游 13 条在 fork 里必然失败的流水线） |
| `scripts/bootstrap-submodules.sh` | **新增** 从 `.gitmodules` 还原 8 个子模块，本地与 CI 共用 |

---

## OpenList 后端设计要点

OpenList（AList 的社区 fork）的 API 有三个和常规 REST 不同的地方，实现里都做了处理：

1. **错误码在响应体里**：大量返回 `HTTP 200 + {code: 401/500}`。所有响应先判 `json.code`，再判 HTTP 状态，否则过期 token 会被当成成功。
2. **`/` 是挂载点列表，不可写**。根路径必须指向某个存储内部的目录（如 `/onedrive/Readest`）。配置页因此提供目录浏览器，而不是一个裸输入框。
3. **下载走 `/p/<path>?sign=` 代理**。签名直链 `/d/` 会 302 到存储驱动，115、天翼等驱动缺少 Referer 会 403；走代理则稳定，代价是消耗 OpenList 服务器带宽。

目录结构与其它后端一致（`Readest/library.json` + `Readest/books/<hash>/`），所以同一个 OpenList 目录可以被 WebDAV 后端和 OpenList 后端同时读写。

---

## 构建

### 0. 补子模块（必须）

本仓库的历史是一次性导入的，**子模块指针没有记录进索引**，所以 `git submodule update` 不会做任何事。用一个脚本从 `.gitmodules` 还原：

```bash
bash scripts/bootstrap-submodules.sh
```

脚本幂等：已有内容的目录直接跳过，缺的 `git clone --depth 1` 并重试 3 次，最后校验 5 个构建关键路径（tauri fork、swift-rs、foliate-js、turso、webview-upgrade）。CI 用的是同一条命令，所以本地能过、CI 必然能过。

> 缺任何一个都会在 `pnpm install`（foliate-js）或 `cargo build`（tauri / turso / webview-upgrade）阶段报错。
> 想保留上游提交历史的话，更省事的做法是 `git clone --recurse-submodules` 官方仓库，再把上面「相对上游的改动」表里的文件覆盖过去。

### 前置

- Node 22+、pnpm 11、Rust 1.90+、VS Build Tools（Windows）/ Xcode CLT（macOS）/ `libwebkit2gtk-4.1-dev`（Linux）

### 本地（验证用，Windows）

```bash
bash scripts/bootstrap-submodules.sh                # 补子模块（缺了就装不上）
pnpm install
pnpm --filter @readest/readest-app setup-vendors    # 复制 pdf.js worker/wasm/fonts

# OneDrive 的 client id 走 .env.tauri —— `pnpm build` 就是 `dotenv -e .env.tauri -- next build`
echo "NEXT_PUBLIC_MICROSOFT_CLIENT_ID=<你的 Azure Application (client) ID>" \
  >> apps/readest-app/.env.tauri

cd apps/readest-app
pnpm tauri build --target x86_64-pc-windows-msvc --no-bundle
# 产物：../../target/x86_64-pc-windows-msvc/release/readest.exe
```

Windows 用 `--no-bundle` 而不是 `--bundles nsis`：NSIS bundler 会在打包阶段从 `tauri-apps/binary-releases` 下载工具链，这一步在 CI 上稳定 504，本机实测同样 000，cargo 编译完再挂在这里很浪费。可执行文件本身是完整的，zip 一下就能用。

`createUpdaterArtifacts` 是在 `tauri.conf.json` 里开启的，所以**本地构建也需要签名私钥**（仓库用的那把在 `~/.tauri/readex.key`）：

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/readex.key)"
```

不想签名就先关掉这个开关，否则 `tauri build` 会在打包阶段直接报错找不到密钥：

```bash
node -e "const fs=require('fs'),p='src-tauri/tauri.conf.json';const j=JSON.parse(fs.readFileSync(p));j.bundle.createUpdaterArtifacts=false;fs.writeFileSync(p,JSON.stringify(j,null,2))"
```

> CI 里这一步是自动的（`Guard updater artifacts`）。**不要**试图用 `--config` 叠加配置：`tauri-action` 会把 `--config` 按仓库根解析，而 tauri CLI 按 `projectPath` 解析，两者永远对不上——第一版流水线就是这么挂的。

### CI（macOS / Linux 必须）

推 tag 触发 `.github/workflows/build-desktop.yml`：

```bash
git tag v0.1.0
git push origin v0.1.0
```

需要的仓库配置：

| 类型 | 名称 | 状态 | 说明 |
|---|---|---|---|
| Secret | `TAURI_SIGNING_PRIVATE_KEY` | **已配置** | 本仓库已生成专属密钥对并写入 Secret；公钥已写进 `tauri.conf.json` 与 `constants.ts` |
| Secret | `ANDROID_KEYSTORE_BASE64` | **已配置** | Android 发布签名的 PKCS12 keystore（base64）。Android 不允许用不同签名覆盖安装，所以这把key必须固定复用，换掉会导致老用户必须先卸载 |
| Secret | `ANDROID_KEYSTORE_PASSWORD` | **已配置** | 上面 keystore 的 store/key 密码 |
| Variable | `MICROSOFT_CLIENT_ID` | **待填** | Azure 应用的 client id；未填时 OneDrive 那一行在设置页里是灰的，其余功能不受影响 |
| Secret | `APPLE_CERTIFICATE` / `_PASSWORD` / `APPLE_SIGNING_IDENTITY` / `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | 可选 | 默认**不**注入（空值会让 tauri 对着空证书跑 `security import`，整包失败）。要签名时先按 `tauri.macos-nonestore.conf.json` 加上 entitlements，再把这些变量加回 workflow 的 `env` |

### Android 签名

`tauri android init` 生成的工程没有 `signingConfigs`，直接 `assembleRelease` 出来的是 `-unsigned.apk`，装不上；退而求其次用 `--debug` 虽然能装，但 Rust debug profile 不 strip 原生库，APK 会到 **659MB**。

所以构建走 release 变体，由 `scripts/patch-android-project.mjs` 往 `app/build.gradle.kts` 追加一段 `signingConfigs`，从 `gen/android/keystore.properties` 读别名和密码；keystore 本身由 workflow 从 `ANDROID_KEYSTORE_BASE64` 解码到 `gen/android/app/readex.p12`。Gradle 会顺带 strip 掉 `.so` 的符号，体积回到几十 MB。

重新生成 keystore（**只在首次搭建或确定要放弃老用户升级路径时做**）：

```bash
keytool -genkeypair -keystore readex.p12 -storetype PKCS12 \
  -alias readex -keyalg RSA -keysize 2048 -validity 10950 \
  -storepass "$PASS" -keypass "$PASS" \
  -dname "CN=Read-EX, OU=Read-EX, O=Read-EX, C=CN"
base64 -w0 readex.p12    # 整段写进 ANDROID_KEYSTORE_BASE64
```

密钥已就位，除非要**换掉**它，否则不用再动：

```bash
pnpm tauri signer generate -w ~/.tauri/readex.key   # 生成新的一对
```

换密钥后必须同时更新三处，否则自动更新静默失效：私钥 → 仓库 Secret，公钥 → `tauri.conf.json` 的 `plugins.updater.pubkey` 与 `src/services/constants.ts` 的 `READEST_UPDATER_PUBKEY`（两处必须一致）。

---

## OneDrive 配置

1. Azure Portal → Entra ID → 应用注册 → 新注册
   - 账户类型：**任何组织目录中的账户和个人 Microsoft 账户**
   - 平台：移动和桌面应用，重定向 URI 填 `readest-onedrive://auth`
     （与 `src/services/sync/providers/onedrive/microsoftOAuthConfig.ts` 中的常量一致；想自定义 scheme 就在两处一起改）
2. API 权限（委托）：`Files.ReadWrite.AppFolder`、`User.Read`、`offline_access`
3. 构建时注入 `NEXT_PUBLIC_MICROSOFT_CLIENT_ID`

> 不要沿用上游的 client id：那是 Readest 官方注册的应用，用于自建发行版违反微软条款，且随时可能被吊销。
>
> OneDrive 的 scope 是 `Files.ReadWrite.AppFolder`，数据固定落在 `应用/<应用名>/` 下，用户看不到根目录也选不了路径 —— 这是微软的隐私约束，不是代码限制。

---

## 品牌名 Read-EX

产品名在 34 个语言包里被逐词翻译成 "Readest"，因此改名没有去动文案 key，而是在
`hooks/useTranslation.ts` 里对 `t()` 的返回值做一次替换。这样一处改动就能覆盖全部界面，
也不会丢掉任何已有翻译。

明确**保留** Readest 字样的地方：

| 位置 | 原因 |
|---|---|
| `Readest Cloud` | readest.com 的托管服务名，改成 Read-EX Cloud 会让人以为有自建后端 |
| `readest.com` / `readest://` | 小写标识符与深链协议，不参与替换 |
| `DATA_SUBDIR = 'Readest'` | 本地数据子目录 |
| `SYNC_BASE_DIR = 'Readest'` | 网盘上的同步根目录 |
| `nodeAppService` 的 `APP_NAME` | 服务端模式的数据目录 |
| 许可证/来源说明 | AGPL 归属 |

其余用户可见处逐个改过：窗口标题（Rust 侧 `title()`）、关于页、剪藏浮层文案、
引用卡片水印、离线页、PWA manifest / `apple-mobile-web-app-title`、LocalSend 与
KOReader/BookOrbit/AudiobookShelf 的客户端标识、Discord RPC 按钮、Linux 启动报错。

> 判断标准是「会不会影响数据」：只改显示名。目录名、协议、identifier 一律不动，
> 否则现有书库、同步目录和配置会「消失」。

---

## 自动更新

三件事必须同时成立，少一件更新就是死的：

1. **release 必须是公开的，不能是 draft**。`https://github.com/K-Thintime/read-ex/releases/latest/download/latest.json`
   对 draft 返回 404，装了旧版的客户端只会一直显示"已是最新"。tag 推送触发的构建现在直接发布。
2. **macOS 必须构建 `app` target**（workflow 里是 `--bundles app,dmg`）。只构建 `dmg` 时
   tauri 会警告 `no updater-enabled targets were built`，不产出 `.app.tar.gz`，`latest.json` 也就无从生成。
3. **Windows / Android 没有 tauri 可自更新的产物**，所以 `helpers/updater.ts` 会退一步查
   GitHub Releases API，拿最新的 tag 和对应资产，由应用自己下载安装。

各平台的更新方式：

| 平台 | 检测 | 安装 |
|---|---|---|
| macOS | tauri updater 读 `latest.json` | 签名校验后原地替换 `.app` |
| Windows | tauri updater 拿不到就查 Releases API | 下载 `Read-EX_<ver>_windows-x64.exe` 到同目录，启动新进程后退出 |
| Android | `latest.json` → Releases API | 下载 apk 交给系统安装器（同签名覆盖安装） |
| Linux deb | 不提供（deb 安装的 `is_updater_disabled` 为 true） | 用 `dpkg -i` 升级 |

交互约束：

- **启动即检查**：每次启动查一次（同一进程内多个页面只查一次），不再有 24 小时节流。
- **可关闭**：设置 → 控制 → 更新 → `启动时检查更新`。
- **可忽略单个版本**：更新窗口里的「跳过此版本」只压制这一个版本号，出下一个版本会重新提示；
  在设置页同一分组里能看到已跳过的版本并「恢复提示」。
- 忽略状态存在 `localStorage`，每台设备独立。

> **配置为什么不会丢**：更新只替换可执行文件，配置目录由 `identifier`（`com.readex.app`）决定，
> 位于 `%APPDATA%\com.readex.app`（Windows）或 `~/Library/Application Support/com.readex.app`（macOS）。
> 因此**不要改 `tauri.conf.json` 的 identifier**，一改就等于换了个应用，旧配置全部读不到。

---

## 已知限制

- **深链 scheme 沿用 `readest`**：与官方版同时安装会竞争该 scheme。改它需要动 `tauri.conf.json`、Android manifest、iOS plist 以及约 20 处代码里的 `readest://` 字面量，收益不大，暂不改。
- **未签名安装包**：Windows 触发 SmartScreen（更多信息 → 仍要运行）；macOS 需 `xattr -dr com.apple.quarantine /Applications/Read-EX.app`。
- **OpenList 代理下载吃服务器带宽**：大库同步建议把 OpenList 挂在带宽充裕的机器上，或直接用 S3 后端。
- **AGPL-3.0**：分发二进制时必须公开源码并附获取方式；因条款冲突，不适合上架 App Store。

---

## 发布到自己的 GitHub

仓库已推送至 **https://github.com/K-Thintime/read-ex**（`main` 分支）。

出包只需推一个 tag：

```bash
git tag v0.1.2
git push origin v0.1.2
```

工作流跑完会**直接发布**（不是 draft）——必须如此，否则 `latest.json` 匿名取不到，自动更新失效。
release 里会带上 `latest.json`，它是更新器唯一的数据源。若只是想验证构建，在 Actions 页面手动运行
*Build Read-EX*，产物以 artifact 形式保留 14 天，不会产生 release。

## 许可证

AGPL-3.0，与上游一致。原始版权归 Bilingify LLC 及 readest 贡献者所有。
