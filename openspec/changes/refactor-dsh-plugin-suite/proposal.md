## Why

0.4.0 已发布。按已确定的方案，将 LocalApp 迁移成 dsh 的多人使用、应用平台、应用开发三个插件。先把真实使用中的用户 Agent 运行时管理从 HTTP 路由移入 Cordis 插件，保持同一个 Server 和现有数据路径。

## What Changes

- 新增多人使用插件包，第一批提供按用户、应用、身份、供应商管理运行时的 Cordis 服务。
- 统一并发初始化、设置变更和关闭处理，容量计算包括正在创建的运行时。
- 现有 Agent API 使用插件；认证仍由现有 Server 执行。
- 后续继续迁移账号、模型设置、Python 环境、dsh 完整客户端及应用平台和应用开发。第一批不会开放尚未完成隔离的 dsh 原生 RPC。

## Capabilities

### New Capabilities
- `dsh-native-client`: 完整客户端、原生接口隔离、轨迹和业务插件兼容。
- `dsh-multiuser-runtime`: 多人使用插件中的 Agent 运行时隔离和生命周期。

### Modified Capabilities

无。

## Impact

新增内部 workspace 包，调整 Server Agent 路由、开发构建和 npm 打包。唯一公开 localapp 包、正式应用 URL、现有 Agent 数据目录保持兼容。
