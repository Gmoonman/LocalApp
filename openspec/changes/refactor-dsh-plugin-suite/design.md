## Context

完整方案见 docs/dsh-plugin-suite.md。本次从真正服务现有请求的运行时管理开始，三个业务插件不拆成大量没有独立用途的小插件。

## Goals / Non-Goals

第一批实现 Cordis 服务、真实 Server 接入、用户和应用分离、并发创建和关闭。不会将单一 OperatorPeer 的原生 dsh Gateway 暴露给多个用户。完整客户端、账号设置和应用平台迁移还需要后续实现。

## Decisions

服务只接收 Server 认证后的用户身份，不读取客户端自报 userId。运行时工厂继续由现有 Harness 提供，插件不依赖 Fastify 或应用数据库。已有用户模式仍使用旧的三元组目录键，新增身份用于内存隔离。每个 key 的创建与关闭串行，容量包含创建中的条目。配置变更先标记对应条目失效，晚完成的工厂结果必须关闭，不能重新加入。Cordis 停止插件时关闭全部条目，不新增监听端口。

## Risks / Trade-offs

这一批不是完整原生 dsh HTTP/WebSocket 用户隔离。原生 Gateway 的连接选择和 unary 调用须同时验证后才能启用。现有 HTTP API 和 Harness 数据格式暂时保留。

## Migration Plan

1. 发布并验证 0.4.0（已完成）。
2. 运行时插件与现有 Server 接入。
3. 多人使用插件迁移账号、供应商、环境，并接入完整 dsh 客户端。
4. 应用平台迁移托管、权限、数据和发布。
5. 应用开发迁移源码、会话、创建和本地同步。
6. 验证升级、回滚及唯一 npm 包。
