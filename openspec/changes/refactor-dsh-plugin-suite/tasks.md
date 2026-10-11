## 1. 第一批运行时插件

- [x] 1.1 [RED] 编写隔离、并发、容量、失效和插件停止的失败测试
- [x] 1.2 [GREEN] 实现 Cordis 多人运行时服务并接入现有 Agent 路由
- [x] 1.3 [REFACTOR] 完成开发构建与唯一 npm 包的源码打包接入

## 2. 后续业务迁移

- [x] 2.0.1 [RED] 为多人插件的 Python 环境与依赖检查导出编写独立加载测试
- [x] 2.0.2 [GREEN] 迁移 Python 环境管理与依赖检查到多人插件，保留现有入口和数据路径
- [x] 2.0.3 [REFACTOR] 接入源码打包和开发流程
- [x] 2.0.4 接入 dsh 原生会话事件、分页和投影，供客户端轨迹使用
- [x] 2.0.5 使用 dsh Trajectory 插件验证工具调用、时序、推理与历史恢复
- [x] 2.0.6 提取不依赖账号与应用平台的文档扩展，迁移公共 Skills 与依赖清单并验证独立加载
- [x] 2.0.7 接入文档扩展停用和重新启用，验证文档运行时停止、其他工作区继续及历史保留


- [x] 2.1 迁移账号、用户模型和管理员 Python 环境到多人使用插件
- [x] 2.1.1 [RED] 编写不依赖 Server 数据库的用户模型加密与隔离测试
- [x] 2.1.2 [GREEN] 迁移模型设置校验、加密、凭据隐藏与类型到多人使用插件
- [x] 2.1.3 [REFACTOR] 验证现有 SQLite 适配、密钥兼容和发布包加载
- [x] 2.2 接入完整 dsh 客户端，验证原生 RPC、事件流与文件权限
- [x] 2.2.1 [RED] 编写统一 Server 中承载 dsh 路由的失败测试
- [x] 2.2.2 [GREEN] 实现 dsh WebServer 承载与每用户原生 Connection
- [x] 2.2.3 [REFACTOR] 验证认证、跨来源检查、凭据服务隔离及现有 Agent 回归
- [x] 2.2.4 将承载接入实际 Harness 与 SessionController，完成正式原生接口
- [x] 2.3 迁移应用平台的托管、权限、数据与发布
- [x] 2.3.1 迁移 server-core 的共享数据、Named SQL、权限、状态转换和 Issue 实现，保留兼容导出并验证独立包
- [x] 2.3.2 为应用平台提供配对的 Client 入口，将应用上下文桥接从多人客户端归还应用平台，并验证平台关闭后的客户端组合
- [x] 2.4 迁移应用开发、创建会话与源码同步
- [x] 2.4.3 为开发者身份提供按用户、应用保存的能力与工具开关，并验证撤销后运行时停止；现有业务应用设置不能替代开发设置
- [x] 2.4.1 建立应用开发插件，迁移源码项目、版本快照和模板读取，验证源码隔离与独立包加载
- [x] 2.4.2 迁移创建草稿、名称确认、初始模板安装和发布处理，接入统一 Cordis 上下文并回归原生客户端
- [x] 2.4.4 完成应用开发 Client 贡献与默认组合的装配，验证不启用开发时不加载开发客户端贡献
- [x] 2.5 完成存量数据升级、回滚和插件组合验收

## 3. 集成验证

| Spec Scenario | E2E Test | Status |
| --- | --- | --- |
| dsh-multiuser-runtime > Scenario: 两个用户使用相同会话 ID | 真实 Harness 两用户模型与历史集成测试 | ✓ |
| dsh-multiuser-runtime > Scenario: 创建期间停止插件 | Cordis 插件生命周期测试（内部逻辑） | ✓ |
| dsh-multiuser-runtime > Scenario: 设置变更期间创建完成 | 插件设置失效测试（内部逻辑） | ✓ |

| dsh-native-client > Scenario: 查看开发会话轨迹 | agent-harness.spec.ts 原生开发轨迹浏览器测试：工具、推理、时序、刷新恢复 | ✓ |
| dsh-native-client > Scenario: 普通用户使用应用 | agent-harness.spec.ts 普通用户正式应用页、SDK 工具、模型与开发权限浏览器测试 | ✓ |
| dsh-native-client > Scenario: 原生会话和搜索隔离 | agent-harness.spec.ts 已配置用户、应用、用户与开发者身份列表/搜索/分页隔离测试 | ✓ |
| dsh-native-client > Scenario: 原生事件流与文件隔离 | agent-harness.spec.ts 已配置用户及应用/身份 WebSocket 订阅、文件凭据和原生图片读取隔离测试 | ✓ |
| dsh-native-client > Scenario: 使用存量应用 | 真实 0.4.0 应用与数据升级回滚、正式入口浏览器渲染、账号及加密配置保留、旧会话格式恢复并通过当前原生接口继续对话；无开发项目的旧应用及独立数据库在升级和回滚后保留；旧发行包自身 Agent 初始化失败单独记录 | ✓ |
| dsh-native-client > Scenario: 完成应用开发和发布 | agent-harness.spec.ts 原生规划/编辑、预览业务读写、本地源码拉取推送、构建发布与正式应用浏览器测试；development.test.ts 存量迁移与同步冲突 | ✓ |

- [x] 3.1 [GREEN] 为 dsh-multiuser-runtime > Scenario: 两个用户使用相同会话 ID 编写并执行集成测试
- [x] 3.2 [GREEN] 为 dsh-multiuser-runtime > Scenario: 创建期间停止插件 编写并执行生命周期测试
- [x] 3.3 [GREEN] 为 dsh-multiuser-runtime > Scenario: 设置变更期间创建完成 编写并执行失效测试
- [x] 3.4 执行相关 Server 测试、类型构建、源码打包和 OpenSpec 严格验证

- [x] 3.5 [GREEN] 为 dsh-native-client > Scenario: 查看开发会话轨迹 编写并执行端到端测试
- [x] 3.6 [GREEN] 为 dsh-native-client > Scenario: 普通用户使用应用 编写并执行端到端测试
- [x] 3.7 [GREEN] 为 dsh-native-client > Scenario: 原生会话和搜索隔离 编写并执行端到端测试
- [x] 3.8 [GREEN] 为 dsh-native-client > Scenario: 原生事件流与文件隔离 编写并执行端到端测试
- [x] 3.9 [GREEN] 为 dsh-native-client > Scenario: 使用存量应用 编写并执行端到端测试
- [x] 3.10 [GREEN] 为 dsh-native-client > Scenario: 完成应用开发和发布 编写并执行端到端测试

### 悬浮 Agent 界面独立插件

- [x] 提取悬浮 UI、附件、会话导航和输入通信到 dsh-agent-ui。
- [x] 应用与开发插件分别注册身份入口，权限继续在服务端检查。
- [x] 接入统一 Server、原生客户端资源和单 npm 包导出。
- [x] 验证独立加载、无开发插件的用户入口、关闭入口和真实页面交互（插件组合与入口为自动化测试，完整应用为真实浏览器）。
