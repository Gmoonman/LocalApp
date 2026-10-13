# 用户模型设置插件

`@localapp/dsh-model-settings` 把 dsh 原生的模型设置接入 LocalApp 的登录用户。
用户仍只安装一个 `localapp` 包，所有请求由原有 Server 接收。

- 界面直接加载 `@deepseek-ai/dsh-client-ui-settings-models`。
- 供应商目录、配置结构、模型发现和模型调用使用 dsh 的 `llm-pi-ai`。
- 插件负责每个用户独立的加密保存、旧配置迁移、登录检查、请求来源检查以及与原有应用接口的连接。
- API Key 不返回给页面或应用，模型请求使用当前用户保存的凭据。不会使用 Server 的环境变量作为其他用户的模型凭据。
- 完整的模型、图片能力、请求参数和附加请求头传给 dsh；应用和开发者会话使用同一份配置。
- 原有 MCP 和应用能力设置保留在个人页。应用对话中的模型选择包含供应商下的各个模型。

## 接入

在 Cordis Context 中安装插件，调用 `localappModelSettings.registerHttp(app, host)`。
`host` 只提供登录身份、统一 Server 的 HTTP/WebSocket 转发和静态文件。
插件不启动额外的监听端口。

个人页：`/my/models`。
原生界面及其 dsh API：`/api/model-settings/native/`。
现有 `/api/agent/settings` 继续给应用返回不含密钥的模型列表。

旧配置首次读取时迁移到 `dataDir/model-settings/`。旧存储保留，其他 Agent 设置仍由多用户插件保存。
当前接入使用用户 API Key；OAuth/系统环境凭据不作为跨用户的共享认证来源。
