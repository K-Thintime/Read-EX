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
| `src-tauri/tauri.conf.json` | `productName` → `Read-EX`，`identifier` → `com.readex.app`，更新器指向本仓库 |
| `src-tauri/tauri.updater.conf.json` | **新增** 仅 CI 使用的更新签名叠加配置 |
| `.github/workflows/build-desktop.yml` | **新增** 三平台打包工作流 |

---

## OpenList 后端设计要点

OpenList（AList 的社区 fork）的 API 有三个和常规 REST 不同的地方，实现里都做了处理：

1. **错误码在响应体里**：大量返回 `HTTP 200 + {code: 401/500}`。所有响应先判 `json.code`，再判 HTTP 状态，否则过期 token 会被当成成功。
2. **`/` 是挂载点列表，不可写**。根路径必须指向某个存储内部的目录（如 `/onedrive/Readest`）。配置页因此提供目录浏览器，而不是一个裸输入框。
3. **下载走 `/p/<path>?sign=` 代理**。签名直链 `/d/` 会 302 到存储驱动，115、天翼等驱动缺少 Referer 会 403；走代理则稳定，代价是消耗 OpenList 服务器带宽。

目录结构与其它后端一致（`Readest/library.json` + `Readest/books/<hash>/`），所以同一个 OpenList 目录可以被 WebDAV 后端和 OpenList 后端同时读写。

---

## 构建

### 0. 先补子模块（必须）

本仓库的历史是一次性导入的，**子模块指针没有记录**。开始构建前先注册：

```bash
git submodule add https://github.com/readest/foliate-js packages/foliate-js
git submodule add https://github.com/readest/tauri packages/tauri
git submodule add https://github.com/readest/simplecc-wasm packages/simplecc-wasm
git submodule add https://github.com/readest/js-mdict packages/js-mdict
git submodule add https://github.com/mozilla/pdf.js.qcms packages/qcms
git submodule add https://github.com/readest/tauri-plugin-turso \
  apps/readest-app/src-tauri/plugins/tauri-plugin-turso
git submodule add https://github.com/readest/tauri-plugin-webview-upgrade \
  apps/readest-app/src-tauri/plugins/tauri-plugin-webview-upgrade
```

> 缺任何一个都会在 `pnpm install`（js-mdict / simplecc-wasm）或 `cargo build`（turso / qcms / tauri）阶段报错。
> 想保留上游提交历史的话，更省事的做法是 `git clone --recurse-submodules` 官方仓库，再把上面「相对上游的改动」表里的文件覆盖过去。

### 前置

- Node 22+、pnpm 11、Rust stable、VS Build Tools（Windows）/ Xcode CLT（macOS）/ `libwebkit2gtk-4.1-dev`（Linux）

### 本地（验证用，Windows）

```bash
pnpm install
pnpm --filter @readest/readest-app setup-vendors   # 复制 pdf.js worker/wasm/fonts

cd apps/readest-app
cat > .env.local <<'EOF'
NEXT_PUBLIC_APP_PLATFORM=tauri
NEXT_PUBLIC_MICROSOFT_CLIENT_ID=<你的 Azure Application (client) ID>
EOF

pnpm build-tauri
pnpm tauri build --target x86_64-pc-windows-msvc --bundles nsis
# 产物：target/x86_64-pc-windows-msvc/release/bundle/nsis/
```

本地构建默认**不生成**更新签名包（`tauri.conf.json` 里 `createUpdaterArtifacts: false`），所以不需要签名私钥。
CI 通过 `--config src-tauri/tauri.updater.conf.json` 叠加开启。

### CI（macOS / Linux 必须）

推 tag 触发 `.github/workflows/build-desktop.yml`：

```bash
git tag v0.1.0
git push origin v0.1.0
```

需要的仓库配置：

| 类型 | 名称 | 必需 | 说明 |
|---|---|---|---|
| Secret | `TAURI_SIGNING_PRIVATE_KEY` | 更新功能必需 | `pnpm tauri signer generate -w ~/.tauri/readex.key` 生成的私钥内容 |
| Secret | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 同上 | 生成时设置的口令 |
| Variable | `MICROSOFT_CLIENT_ID` | OneDrive 必需 | Azure 应用的 client id |
| Secret | `APPLE_CERTIFICATE` / `_PASSWORD` / `APPLE_SIGNING_IDENTITY` / `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | 可选 | 不加则产出未签名 dmg |

生成密钥后，**必须**把公钥写回 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`，并把 `endpoints` 里的 `OWNER` 换成你的 GitHub 用户名。否则自动更新会签名校验失败。

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

## 已知限制

- **深链 scheme 沿用 `readest`**：与官方版同时安装会竞争该 scheme。改它需要动 `tauri.conf.json`、Android manifest、iOS plist 以及约 20 处代码里的 `readest://` 字面量，收益不大，暂不改。
- **未签名安装包**：Windows 触发 SmartScreen（更多信息 → 仍要运行）；macOS 需 `xattr -dr com.apple.quarantine /Applications/Read-EX.app`。
- **OpenList 代理下载吃服务器带宽**：大库同步建议把 OpenList 挂在带宽充裕的机器上，或直接用 S3 后端。
- **AGPL-3.0**：分发二进制时必须公开源码并附获取方式；因条款冲突，不适合上架 App Store。

---

## 发布到自己的 GitHub

```bash
cd readest-main
git remote add origin https://github.com/<你的账号>/read-ex.git
git branch -M main
git push -u origin main
```

之后推 tag 即可让 Actions 出包（见下）。

---

## 许可证

AGPL-3.0，与上游一致。原始版权归 Bilingify LLC 及 readest 贡献者所有。
