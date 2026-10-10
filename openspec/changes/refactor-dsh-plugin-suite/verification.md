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

## 用户模型设置迁移

模型与 MCP 配置校验、AES-GCM 加密、凭据隐藏和能力偏好类型已迁入多人使用插件。现有 Server 仅通过存储接口访问原 SQLite 表，密钥文件和加密格式不变。独立插件模型存储、凭据隐藏、跨用户密文复制拒绝、现有模型设置与真实 HTTP Agent 测试共 4 个文件 9 项通过；插件及 Server 类型构建通过；打包后的独立 Server 启动通过。

## 原生 dsh 承载

EmbeddedWebServer 复用 dsh WebServer 注册接口，将路由交给现有 Server，不创建监听端口。每个用户 Context 有独立原生 Connection，保留 dsh Host/Origin 检查及 RPC 协议。内部令牌与 Cookie 不返回客户端，连接凭据服务与模型凭据服务隔离。

真实 HTTP 测试使用现有 API Key 验证逻辑选择两名用户的 Context：未认证或无效 Key 返回 401，伪造请求体用户不能改变身份，跨来源返回 403，跨用户调用及停止后的调用被拒绝。精确路由、前缀边界、fallback 注册与撤销通过；现有 Agent HTTP 与运行时测试一并执行，共 4 个文件 13 项通过，类型构建通过。

当前只是承载基础和测试中的原生 RPC，尚未在正式应用入口开放原生接口。SessionController、Gateway 正式集成，会话搜索、WebSocket、文件隔离和 Trajectory 界面仍未完成。

## 真实 Harness 原生会话与正式 HTTP 历史接口

真实 Harness 已加载 dsh SessionController、SQLite SessionQuery、附件和上传服务，并通过官方 Typert 描述注册 Gateway。会话创建的目录校验在调用上游直接创建目录前执行。两个用户的会话列表与原始轨迹快照隔离测试通过；相关 4 个文件 10 项测试通过，插件与 Server 类型构建通过。

统一 Server 已开放原生 session/list 与 session/page HTTP 路径，沿用现有认证、应用访问检查和模型设置。真实 HTTP Agent 测试 5 项通过，覆盖未认证、不可访问应用和跨来源拒绝。page 路径尚未完成真实 HTTP 分页验收。写入、WebSocket、应用工具绑定、开发者身份和完整客户端仍在迁移中，不能据此声称原生客户端整体完成。

## 原生历史分页与重启恢复

原生 Gateway 的 page 使用 follow 快照 cursor 读取完整历史，包含用户输入与原始轨迹事件；跨用户 sessionId 读取被拒绝。关闭 Harness 后在同一路径重新创建 Harness，原生 page 返回相同记录。统一 Server 的正式原生 page HTTP 入口返回实际持久化事件和用户输入。上述真实 Harness 与 HTTP Agent 测试共 2 个文件 6 项通过。原生 WebSocket 与完整客户端尚未接入，分页证据不能代替浏览器轨迹验收。

## 统一 Server 原生 WebSocket

原生 Gateway 的 remote.mux 现在通过现有 Server 和 Fastify 认证处理，不新增监听端口。upgrade 观察器只保存升级字节，实际分发在完成认证和应用检查后执行。真实 WebSocket 接收原生 follow 快照，并在现有 Agent 运行新一轮后接收到实时 inbox 轨迹事件；取消逻辑流后关闭连接。未认证返回 401、不可访问应用返回 400、跨来源返回 403。HTTP Agent 与原生流测试 7 项通过，原有消息总线和 WebSocket 元数据相关 3 个文件 29 项测试通过，Server 类型构建通过。完整客户端、浏览器轨迹、开发者身份和写入工具绑定仍未完成。

## 原生客户端模块装配基础

新增 native-client 模块，通过真实 Cordis Loader 加载 dsh UI 插件的 Host 入口，并由官方 ClientModuleRegistry 读取原始客户端 bundle。Trajectory、Chat、Conversation、Session、Renderer 和 Locale 已加入精确版本依赖。加载测试确认注册图中存在官方 Trajectory 插件，并能解析其 client.js 产物。客户端模块、原生历史和真实 HTTP Agent 相关 3 个文件 9 项测试通过，插件类型构建和离线 frozen-lockfile 安装通过。

该模块尚未接到正式页面，原生会话控制器等客户端依赖仍需完整装配，不能视为整个浏览器客户端已启动；现有界面尚未替换，也没有宣称通过浏览器验收。

## 客户端模块依赖图与事件流握手

原生客户端模块清单补齐为 23 个官方模块，测试逐个检查声明的 inject 模块均存在，并逐个读取官方 bundle。模块资源 Context 禁止与已有 Agent 执行 Context 混用，避免为资源扫描加载额外执行服务。模块依赖图和 bundle 可读仅证明客户端资源装配，尚不证明浏览器服务全部激活。

真实 Harness 已接入官方 api-remotes 的事件源；通过统一 Server 的真实 WebSocket 验证客户端 $events 流收到 ready 和 clientId。模块资源、原生历史和真实 HTTP Agent 相关 3 个文件 10 项测试通过，插件和 Server 类型构建通过，离线 frozen-lockfile 安装通过。正式页面启动、发布包内的客户端资源和所有模式浏览器验收仍需继续实施。

## 安装包中的原生客户端资源

Server 打包现在包含多人插件的内部库及其 dsh 运行时和客户端依赖。内部库直接从源文件编译，不读取工作区旧 dist。独立目录中的安装包通过真实 Cordis Loader 注册至少 23 个客户端模块，并逐个确认客户端产物位于安装包目录内、bundle 返回 200。相同源码连续打包摘要一致；独立 Server health 与初始化页面验证通过。该测试不代表原生客户端已在浏览器渲染，正式页面入口仍待接入。

## 原生 Web 启动入口

新增浏览器入口直接运行官方 AppWebEntry，并在 pagehide 时释放插件树。构建沿用上游对 Cordis Loader 的浏览器 Node 模块适配和环境定义；生成 entry.js、entry.css 和字体资源，全部进入 Server 包。浏览器入口构建测试通过，独立 Server 包的两次打包摘要一致、原生模块解析和资源读取、health 与初始化页面测试通过；插件类型构建和离线 frozen-lockfile 安装通过。

正式页面路由、会话操作和应用工具绑定尚未完成，未执行完整浏览器启动及轨迹 UI 验收。上述构建与资源证据不能替代页面功能验收。

## 原生客户端应用工作区

真实 Harness 接入官方 WorkspaceController 与其 Typert 描述。应用实现仅允许注册配置中的 workspaceRoot；默认初始化使用该目录，不使用上游系统 Documents 路径。两用户测试分别验证自己的工作区路径和其他目录拒绝，历史分页与重启恢复继续通过。统一 Server 的原生 workspace/initializeDefault HTTP 入口返回当前用户运行时的应用目录。真实 Harness 与 HTTP Agent 相关 2 个文件 9 项测试、插件和 Server 类型构建通过。客户端完整页面和会话写入仍待实施。

## 原生页面的应用与供应商路径及启动资源服务

新增只包含 appId 和 providerId 的原生路径编码，用户身份始终来自 Server 认证；不接受附加用户字段、不合法配置或超长编码。正式原生 HTTP 和 WebSocket 增加固定应用、固定供应商路径，查询参数不能改写该路径所选运行时。真实 HTTP 与实时轨迹流测试通过。

新增 NativeClientAssets Cordis 服务，在独立 Context 中加载官方模块并生成 dsh 的启动注入表，父级 Agent 服务不进入资源 Context。资源分发只允许 plugins 路径；生命周期等待装配后释放内部 Context。原生启动表、路径编码和真实 HTTP Agent 相关 3 个文件 11 项测试通过，插件及 Server 类型构建通过。资源服务尚未连接正式页面路由，浏览器页面验收仍未完成。

## 统一 Server 原生页面入口

新增固定应用、供应商路径下的原生 HTML 页面、官方 plugins 资源和浏览器入口资源。页面与资源均通过现有认证、应用访问及供应商检查；无尾斜杠的页面重定向到稳定目录，组合资源根路径和子文件均能加载。开发启动会先构建原生浏览器入口，发布 launcher 指定包内资源目录。源码侧真实 HTTP Agent 测试 10 项、Server 类型构建和源码门禁 13 项通过。

增强独立安装包测试后发现旧 CommonJS 合并会改变 Harness ESM 默认导出的形态。打包现在保留单独的 harness.mjs，由同一个 Server/worker 加载；不新增 Server。独立包初始化账号、保存测试模型配置、获取原生页面及浏览器入口脚本通过，连续两次打包摘要一致，全部原生模块仍从包内读取。

该页面尚未连到正式应用的悬浮入口，没有完成浏览器整体启动、会话写入及应用工具绑定验收，不能视为完整原生客户端交付。

## 原生会话创建校验

真实 Gateway 创建测试发现上游接受 ../escape 会话 ID。应用 SessionController 现在在创建前校验显式 ID，仅接受 1 至 128 个字母、数字、下划线或连字符。测试覆盖默认创建、合法指定 ID、路径穿越、绝对路径、空值和超长值；与原生历史恢复测试合计 2 项通过，插件类型构建通过。完整会话写入 HTTP、模型选择和应用工具绑定仍待接入。
