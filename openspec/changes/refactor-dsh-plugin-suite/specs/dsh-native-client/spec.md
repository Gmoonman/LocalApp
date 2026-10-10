## ADDED Requirements

### Requirement: 复用完整 dsh 客户端
LocalApp SHALL 使用 dsh 的客户端服务、Conversation、Chat 和 Trajectory 插件，保留应用页面及现有浮动、最小化、历史与身份切换行为。

#### Scenario: 查看开发会话轨迹
- **WHEN** 应用所有者在开发者身份完成含工具调用的 Agent 对话并打开轨迹
- **THEN** dsh Trajectory 展示原生执行事件、工具调用和时序，刷新后能够恢复历史轨迹

#### Scenario: 普通用户使用应用
- **WHEN** 普通用户通过应用内 Agent 入口对话
- **THEN** 使用该用户配置的模型与已启用工具，不能修改应用源码或进入开发者身份

### Requirement: 原生接口按用户与应用隔离
LocalApp SHALL 在现有统一 Server 中为原生 dsh HTTP、WebSocket、文件与订阅请求选择已经认证的用户、应用和身份上下文，不额外启动 Server。

#### Scenario: 原生会话和搜索隔离
- **WHEN** 两个用户通过原生 dsh 接口列出、分页或搜索会话
- **THEN** 只得到各自用户、应用和身份的会话

#### Scenario: 原生事件流与文件隔离
- **WHEN** 用户尝试订阅其他用户的会话或访问其文件
- **THEN** 请求被拒绝且没有内容泄露

### Requirement: 业务插件组合与存量兼容
多人使用、应用平台与应用开发 SHALL 作为具有实际贡献的 Cordis 插件组合，保留原有应用、数据、登录、模型配置、源码、会话及发布能力。

#### Scenario: 使用存量应用
- **WHEN** 0.4.0 的数据目录在完成插件化的 Server 中启动
- **THEN** 原有应用、用户数据、模型配置和会话可继续使用，旧应用不因缺少源码而停止服务

#### Scenario: 完成应用开发和发布
- **WHEN** 所有者在线创建应用或同步存量源码后进行开发、检查、预览和发布
- **THEN** 相同会话归属应用，正式入口展示发布结果，本地拉取和推送仍可使用
