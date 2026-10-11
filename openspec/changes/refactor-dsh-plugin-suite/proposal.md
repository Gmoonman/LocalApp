## Why

0.4.0 已发布。按已确定的方案，将 LocalApp 迁移成 dsh 的多人使用、应用平台、应用开发三个插件，文档处理作为可选扩展。保留同一个 Server、现有数据路径和唯一 npm 包，复用 dsh 的执行与轨迹能力。

## What Changes

- 多人插件提供账号、认证、个人模型、系统 Python 环境，以及按用户、应用、身份管理的 Agent 运行时。
- 应用平台插件提供托管、权限、正式数据、应用入口和业务 Agent；开发插件提供创建会话、源码、构建、预览、发布和本地同步。
- 接入 dsh 原生客户端、RPC、事件流与 Trajectory；工具调用、推理、执行时序和历史恢复使用原生记录。
- 统一并发初始化、设置失效和停止处理，释放连接、任务、子进程和订阅，同时保留数据及历史。
- 唯一 npm 发行包提供公开插件入口及类型，包含对应客户端与运行资源；支持多人、应用运行和完整开发三种组合。
- 验证存量应用、账号、加密凭据、源码和会话升级及恢复，最终完成条件以 tasks.md 和逐项验证证据为准。

## Capabilities

### New Capabilities
- `dsh-native-client`: 完整客户端、原生接口隔离、轨迹和业务插件兼容。
- `dsh-multiuser-runtime`: 多人使用插件中的 Agent 运行时隔离和生命周期。

### Modified Capabilities

无。

## Impact

新增内部 workspace 包，调整 Server Agent 路由、开发构建和 npm 打包。唯一公开 localapp 包、正式应用 URL、现有 Agent 数据目录保持兼容。
