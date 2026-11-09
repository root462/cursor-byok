<div align="center">

# cursor-byok

在 Cursor 中使用你自己的模型服务。

[English](./README-EN.md) · [下载](https://github.com/root462/cursor-byok/releases/latest) · [快速开始](#快速开始) · [提交问题](https://github.com/root462/cursor-byok/issues)

[![Release](https://img.shields.io/github/v/release/root462/cursor-byok?style=flat-square)](https://github.com/root462/cursor-byok/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/root462/cursor-byok/total?style=flat-square)](https://github.com/root462/cursor-byok/releases)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey?style=flat-square)](https://github.com/root462/cursor-byok/releases/latest)

</div>

## 这是什么

cursor-byok 是一个运行在本机的 Cursor 模型网关。它在本机启动一个服务，接收 Cursor Agent 的请求，转发到你配置的模型服务，并尽量保留 Agent 的工具调用、Skills、MCP 与多轮对话能力。

支持接入 OpenAI 与 Anthropic 兼容的服务，可自定义端点、模型 ID、API Key 与请求参数，使用平台内置选项之外的模型通道。

> [!IMPORTANT]
> 本软件免费开源，但所接入的模型 API 可能按用量计费。本项目不提供免费额度，也不解锁 Cursor 付费功能。与 Cursor 官方无隶属或背书关系。

## 功能

- **自带模型通道**：自行配置端点、凭据和模型 ID。
- **多种协议**：支持 OpenAI Responses、OpenAI Chat Completions、Anthropic Messages 兼容服务。
- **模型管理**：新增、复制、编辑、排序、分组，探测可用模型，批量测试连通性。
- **连接测试与调用详情**：测试连通性，查看调用状态与延迟，可选记录完整请求与响应。
- **Agent 流程**：在后端适配工具调用与多轮对话；实际能力取决于模型与 Cursor 客户端的兼容性。
- **用量统计**：按你配置的费率统计 token 用量、缓存命中率与成本估算。
- **提交与 TAB 设置**：分别指定提交信息生成模型与 TAB 路由。
- **本地 API**：通过独立访问密钥，让本机其他应用调用已配置的模型。
- **跨平台桌面应用**：提供 Windows x64、macOS Apple Silicon / Intel、Linux x64 安装包。

## 快速开始

### 下载安装

从 [Releases](https://github.com/root462/cursor-byok/releases/latest) 下载对应安装包：

| 平台 | 安装包 |
| --- | --- |
| Windows x64 | `.exe` 安装程序，需要 WebView2 运行时 |
| macOS Apple Silicon（M 系列） | 文件名含 `aarch64` 的 `.dmg` |
| macOS Intel | 文件名含 `x64` 的 `.dmg` |
| Linux x64 | `.deb`（Debian / Ubuntu 系）或 `.AppImage` |

macOS 安装包未经 Apple 开发者签名与公证，可能触发系统安全提示。请核对来源与 Releases 页面提供的 SHA-256 校验值；不要全局关闭系统安全保护。AppImage 需要先赋予执行权限。

### 配置使用

1. 保存好 Cursor 中的工作，启动 cursor-byok，在侧边栏打开 **模型配置 → Cursor**。
2. 按提示点击 **初始化 CA** 并完成本地证书信任。该 CA 用于本地 HTTPS 代理，私钥请勿外泄。
3. 点击 **添加模型**，填写类型、端点、API Key 与模型 ID，保存后点击 **测试**。
4. 测试通过后，开启 **启用 Cursor 接管**，确认状态为 **已接管**。接管过程可能终止 Cursor 进程，请先保存工作。
5. 重新打开 Cursor，手动选择所配置的模型，发送一条短消息。
6. 在 **调用详细** 中查看请求状态与用量。使用本地模型期间请保持 cursor-byok 运行。

如需停止使用本地代理，先在 Cursor 页面关闭接管，再退出应用。

> [!TIP]
> **Auto 不会自动选中你的本地模型。** 你可以直接在原会话中继续，无需删除或新建对话。若客户端提示继续或恢复，请先在原会话中尝试。

## 模型配置

每个配置都是独立的上游通道，拥有各自的协议、凭据与生成参数。

### 模型类型与协议

| 服务 API | 模型类型 | 请求协议 |
| --- | --- | --- |
| Anthropic 兼容 | **Anthropic** | Messages API |
| OpenAI Responses 兼容 | **OpenAI** | Responses API |
| OpenAI Chat Completions 兼容 | **OpenAI** | Chat Completions API |

请按服务商实际暴露的 API 选择协议，不要只依据模型名称。参数支持、缓存统计与工具调用能力会因服务商而异。

### 常用字段

- **服务地址**：填写基础 URL 由应用拼接标准端点，或开启完整请求 URL 选项使用精确地址。
- **API Key**：上游模型服务商的访问密钥，与本地外部 API 的访问密钥不同。
- **模型 ID**：服务商接受的标识符；可用模型探测查询其返回列表。
- **显示名称与备注**：仅影响列表展示，不改变上游模型 ID。
- **上下文与输出上限**：按模型实际能力设置上下文窗口与最大输出 token。
- **生成参数**：按需配置 reasoning / thinking 选项、自定义请求头与额外 OpenAI / Anthropic 参数。

自定义请求头与额外参数必须是仅含受支持字段的 JSON 对象。保存后请点击 **测试**，再用一个小任务验证流式输出、工具调用与所需参数。

## TAB 与其他设置

Cursor Tab 补全使用独立的 TAB 服务，而非 Agent 模型通道。在侧边栏 **设置 → TAB 配置** 中可选：

- **直连**：连接 Cursor 官方 TAB 服务，受账号权限与额度限制。
- **自定义**：填写实现兼容 TAB 端点的服务地址、该服务要求的访问密钥，以及补全要使用的模型。普通对话 API 无法直接替代 TAB 服务。
- **使用已配置模型**：不需要地址和密钥，补全请求由本机「模型配置」里的模型直接生成（`StreamCpp` 在本机解析文件与光标位置后请求该模型），已启用的插件模型同样可选（按插件模型 ID 寻址，经插件 Provider 路由）。光标预测、TAB 配置等其他 RPC 仍走 Cursor 官方。补全质量取决于所选模型，速度明显慢于 Cursor 自带的小模型。

模型下拉框会同时列出本机已配置模型、已启用插件模型的模型名，以及该服务返回的模型列表，可直接点选，也可以手填。

自定义服务会把密钥以 `Authorization: Bearer <密钥>` 连同对应的 `x-cursor-checksum` 一起发送，并把选中的模型写入 `StreamCpp` 与 `StreamNextCursorPrediction` 请求的 `model_name` 字段。密钥留空时沿用 Cursor 自己的凭证，模型留空时沿用 Cursor 选择的模型。点击 **获取模型** 会读取该服务的 OpenAI 兼容模型列表（`{地址}/v1/models`，失败时回退 `{地址}/models`），选中即可，无需手写模型名。

系统设置中还提供 **提交设置**：选择已配置的模型并编辑提示词，或选择 **直连** 使用 Cursor 官方服务。

**外部 API** 默认关闭。开启后使用显示的本地地址与独立访问密钥调用已配置模型。请勿将本地管理服务直接暴露到公网。

## 与官方账号共存

cursor-byok 可将已配置的模型经由本地网关转发，未匹配的模型请求则转发至 Cursor 上游。

- 在 Cursor 中显式选择本地模型与官方模型。
- **Auto 使用官方模型**，官方额度耗尽时不会切换到你的模型通道。
- 官方模型、TAB 直连等其他官方功能仍受账号权限、额度与服务策略约束。
- Cursor 自行管理插件、Skills 与 MCP，可用性取决于客户端、账号与模型兼容性。

## 工作原理

```text
Cursor 客户端
    │
    │ Agent 请求与工具结果
    ▼
cursor-byok 本地服务
    │
    │ OpenAI / Anthropic 兼容请求
    ▼
你的模型 API
```

API Key、模型配置与应用设置均保存在本地。应用数据目录为当前用户主目录下的 `.cursor-byok-v3`。模型请求发送至你所选的服务商；官方与 TAB 请求遵循各自的路由设置。

请遵守各服务商的隐私政策与计费规则。详细记录可能包含代码、对话或工具结果，请勿公开上传数据库、CA 私钥、API Key 或未脱敏日志。成本数字为估算值，非服务商账单。

## 常见问题

**请求卡住或模型调用失败？**

先检查 CA 信任、接管状态、模型测试结果，以及 Cursor 中选中的模型；再检查服务商地址、协议、模型 ID 与网络代理。反馈问题时请附上同一时间段的脱敏日志。

**已有对话提示运行时不兼容？**

在 Cursor 提示时于原会话中继续或恢复。若仍失败，保存工作后完全退出并重启 Cursor，重新打开该会话并再次选择所配置的模型。无需删除对话或清空数据库。诊断提示不代表已成功恢复；自动重路由取决于客户端状态。并非所有 Cursor 版本或对话都能保证兼容。

## 项目结构

```text
cursor-byok/
├── apps/desktop/     # React 管理界面与 Tauri 桌面集成
├── server/           # Rust 网关、Agent 执行、控制 API 与 SQLite 存储
├── crates/           # 共享 Rust 库与代码搜索核心
├── protocols/        # Cursor 协议定义
├── support/          # 协议提取、抓包与基准测试工具
├── images/           # 项目展示图片
├── Cargo.toml        # Rust workspace 配置
└── Makefile          # 开发、检查与构建命令
```

## 本地开发

### 环境要求

- Git、Node.js / npm、Rust / Cargo。
- 对应系统的 [Tauri 2 构建依赖](https://v2.tauri.app/start/prerequisites/)。
- Windows 另需 Rust MSVC 工具链、Visual Studio C++ 生成工具、Windows SDK 与 WebView2 运行时。

### 安装依赖并启动

```bash
git clone https://github.com/root462/cursor-byok.git
cd cursor-byok/apps/desktop
npm ci
npm run tauri:dev
```

桌面开发环境会使用当前用户的应用数据与 Cursor 配置，并非隔离沙箱。

### 检查与构建

在 `apps/desktop` 中运行 `npm run check` 进行前端检查。在仓库根目录运行：

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --all-targets
```

不依赖 GNU Make 时，在 `apps/desktop` 中生成本地 Windows 安装包：

```powershell
npm.cmd run tauri:build:local
```

产物位于仓库根目录的 `target/release/bundle/nsis/`。该命令不生成 updater 签名产物，也不代表已完成 Windows 代码签名。macOS / Linux 构建需要各自的平台依赖，签名发布需要维护者提供签名密钥。

安装 GNU Make 后，也可在仓库根目录使用 `make dev-web`、`make dev-desktop`、`make check`、`make build-server`。Windows 的 CRLF 检出可能影响提示词模板测试中的 LF 断言，排错时请留意测试输出。

## 自动更新

应用启动后会检查 GitHub Releases 上的最新版本。发现新版本时，侧边栏 **系统设置** 会显示提示，确认后下载、校验签名并重启完成更新。

Windows 使用 `.exe` 安装程序更新，macOS 使用 `.dmg`，Linux 使用对应的包格式。更新包由发布流程使用 minisign 签名，客户端校验公钥不匹配的包会被拒绝。

## 反馈

- [Issues](https://github.com/root462/cursor-byok/issues)
- [下载与版本说明](https://github.com/root462/cursor-byok/releases)

反馈问题时请附上操作系统、Cursor 与 cursor-byok 版本、模型类型、请求协议、错误信息与复现步骤。请勿公开 API Key、私人代码或其他凭据。

## 致谢

本项目由 leookun 原创开发，感谢原作者的工作。