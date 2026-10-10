# LocalApp 多人使用插件

这是 dsh 插件迁移的第一批实现，不单独发布 npm 包。LocalApp 仍提供唯一 CLI 和 Server。

当前贡献是 Cordis 服务 `ctx.localappMultiuser`：按已经认证的用户、应用、身份和供应商管理 Agent 运行时，协调并发创建、配置失效、容量与插件关闭。现有 Server Agent API 已使用该服务；插件不依赖 Fastify、应用数据库或本机路径。

服务只在 Server 内使用，调用方负责认证和创建真正的 dsh Harness。它没有远程 RPC 装饰，也不把运行时或模型密钥交给浏览器。已有 Harness 的磁盘目录继续使用原来的键。

管理员 Python 环境管理和依赖检查已迁入本插件，可通过 `python-environment` 与 `agent-environment` 子入口独立使用。现有 Server 入口继续转发，配置文件保持兼容。

账号、模型设置和完整 dsh 客户端将在后续迁入。完整方案见 `docs/dsh-plugin-suite.md`；实现进度见 `openspec/changes/refactor-dsh-plugin-suite/tasks.md`。
