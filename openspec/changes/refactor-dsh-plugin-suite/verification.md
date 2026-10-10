# 第一批验证记录

0.4.0 发布于 npm latest，原始 GitHub CI 包的完整性与 registry 一致。从 registry 全新安装后 CLI 返回 0.4.0，统一 Server health 为 ok、入口返回 200。

本批实现位于 codex/dsh-plugin-suite 分支。

- 多人插件、真实 Harness、应用设置与真实 HTTP Agent 测试：4 个文件、16 项通过。
- 两个真实 Harness 使用同一 session ID：各自模型请求与历史分离；模型响应使用测试服务，不表示外部模型供应商可用性验收。
- 并发创建去重、创建中容量、失败释放、设置失效与 Cordis 停止清理通过。
- 多人插件和 Server TypeScript 构建通过。
- 源码门禁测试 13 项通过，按正式公开路径筛选的当前提交扫描没有违规。
- npm 内部 Server 包在独立目录启动、health 与初始化页面通过；移走多人插件 dist 后再次源码打包及启动通过，验证发布构建不依赖旧插件编译产物。
- OpenSpec 全部严格验证：113 项通过。

尚未完成：账号、供应商设置与 Python 环境迁移、完整 dsh 客户端和原生 HTTP/WebSocket 隔离、应用平台与应用开发插件迁移、全部升级与回滚测试。第一批不开放原生 dsh Gateway；现有 HTTP Agent API 继续服务。

本批没有重新执行整个 Server 测试集，也没有浏览器 UI 改动。0.4.0 本地全量测试中已记录的 macOS builtin 代理隔离问题仍需后续处理，不能据本批相关测试声称已修复。

## 系统 Python 环境迁移

管理员 Python 环境管理与依赖检查现在由多人使用插件提供。Server 的旧模块转发到插件，已有配置文件的路径和内容保持一致。独立模块加载、旧配置读取、不合法选择不改写配置、Agent 工具和应用设置测试共 5 个文件 23 项通过；多人插件和 Server 类型构建通过；包含新模块的独立 Server 包启动测试通过。完整 dsh Trajectory 接入仍未完成。
