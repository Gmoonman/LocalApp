## 1. 第一批运行时插件

- [x] 1.1 [RED] 编写隔离、并发、容量、失效和插件停止的失败测试
- [x] 1.2 [GREEN] 实现 Cordis 多人运行时服务并接入现有 Agent 路由
- [x] 1.3 [REFACTOR] 完成开发构建与唯一 npm 包的源码打包接入

## 2. 后续业务迁移

- [ ] 2.0.1 [RED] 为多人插件的 Python 环境与依赖检查导出编写独立加载测试
- [ ] 2.0.2 [GREEN] 迁移 Python 环境管理与依赖检查到多人插件，保留现有入口和数据路径
- [ ] 2.0.3 [REFACTOR] 接入源码打包和开发流程
- [ ] 2.0.4 接入 dsh 原生会话事件、分页和投影，供客户端轨迹使用
- [ ] 2.0.5 使用 dsh Trajectory 插件验证工具调用、时序、推理与历史恢复


- [ ] 2.1 迁移账号、用户模型和管理员 Python 环境到多人使用插件
- [ ] 2.2 接入完整 dsh 客户端，验证原生 RPC、事件流与文件权限
- [ ] 2.3 迁移应用平台的托管、权限、数据与发布
- [ ] 2.4 迁移应用开发、创建会话与源码同步
- [ ] 2.5 完成存量数据升级、回滚和插件组合验收

## 3. 集成验证

| Spec Scenario | E2E Test | Status |
| --- | --- | --- |
| dsh-multiuser-runtime > Scenario: 两个用户使用相同会话 ID | 真实 Harness 两用户模型与历史集成测试 | ✓ |
| dsh-multiuser-runtime > Scenario: 创建期间停止插件 | Cordis 插件生命周期测试（内部逻辑） | ✓ |
| dsh-multiuser-runtime > Scenario: 设置变更期间创建完成 | 插件设置失效测试（内部逻辑） | ✓ |

- [x] 3.1 [GREEN] 为 dsh-multiuser-runtime > Scenario: 两个用户使用相同会话 ID 编写并执行集成测试
- [x] 3.2 [GREEN] 为 dsh-multiuser-runtime > Scenario: 创建期间停止插件 编写并执行生命周期测试
- [x] 3.3 [GREEN] 为 dsh-multiuser-runtime > Scenario: 设置变更期间创建完成 编写并执行失效测试
- [x] 3.4 执行相关 Server 测试、类型构建、源码打包和 OpenSpec 严格验证
