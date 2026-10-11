import type { FastifyInstance } from "fastify";

const STARTER_DOC = `# LocalApp 快速上手（面向 AI Agent 与开发者）

本文件由 LocalApp Server 提供，当前实例：{{origin}}

LocalApp 支持在线创建应用，也支持用外部 Agent 在本地开发。平台提供认证、数据、文件和 Agent 能力。

## 在线创建与开发（推荐）

登录 {{origin}}，配置自己的模型供应商，点击“创建应用”并描述需求。
Agent 理解需求、确定名称并创建模板应用后，会带你进入应用页面，继续同一段开发对话。
应用所有者可以切换开发者与用户模式；完成检查和预览后点击上线。
这条路径不需要在用户电脑安装 CLI。

## 外部 Agent 与本地开发

只需安装一个包：插件、CLI、统一 Server 和模板都由 LocalApp 提供，不需要另外安装 dsh。
需要 Node.js >= 24；文档 Skills 的 Python 等依赖在系统环境设置中检查。

\`\`\`bash
npm install -g @patodo/localapp
localapp --version
localapp server
\`\`\`

启动的是本机统一 Server。线上连接与本地连接使用不同 profile，避免把本地验证安装到线上。

### 1. 连接线上平台

登录 {{origin}}，在 {{origin}}/my/keys 创建 API Key；身份由 API Key 确定，不需要另传用户名。
不要把密钥写入源码或发送到对话中。

\`\`\`bash
localapp login {{origin}} --api-key <API_KEY> --profile online
localapp whoami --profile online
\`\`\`

### 2. 下载应用源码

\`\`\`bash
localapp app pull --profile online --name my-app --directory ./my-app
cd my-app
\`\`\`

目标目录必须不存在。应用需要先托管原始源码；旧应用只有发布包时，应先按源码迁移说明上传原始项目。
当前 pull 下载源码到目录，并不会自动在本地 Server 创建、安装应用，也不会下载线上业务数据。

### 3. 编辑与本地验收

让 Codex、Claude Code 等外部 Agent 阅读项目的 \`AGENTS.md\` 和 \`.claude/skills/localapp*/SKILL.md\`，再实现需求。
按项目说明安装依赖、构建和运行 \`localapp check\`。本地调试可用 \`localapp dev\`。
需要验证平台功能时，连接本地 Server 为 local profile，并明确执行 \`localapp app install --target local\`。
新建本地项目可使用 \`localapp init my-app\`，它只创建本地项目；完成后再明确安装到 local profile。

### 4. 上传源码，再决定上线

在源码目录执行：

\`\`\`bash
localapp app push --profile online --directory .
\`\`\`

push 只上传源码，不会自动上线或替换线上业务数据。它会检查下载时的源码基准；线上已修改时会拒绝覆盖。
回到线上应用的开发者模式，检查、构建、预览，确认后点击上线。
源码 pull/push 与整个应用及数据的 Server 间同步是不同操作，不要混用。

## 正式入口验收

从 \`{{origin}}/<owner>/<app>/\` 验证发布结果；\`/serve/<owner>/<app>/\` 仅用于资源与 API 诊断。

## CLI 速查

| 命令 | 说明 |
| --- | --- |
| \`localapp login <url> --api-key <key>\` | 保存某实例的凭据（\`--profile\` 命名） |
| \`localapp whoami\` / \`localapp logout\` | 查看 / 移除当前凭据 |
| \`localapp init [name]\` | 初始化应用项目 |
| \`localapp dev\` | 本地开发 |
| \`localapp check [--json]\` | 校验应用、契约与迁移 |
| \`localapp app install [--target <profile>]\` | 构建并安装到 Server |
| \`localapp app pull --profile online --name my-app --directory ./my-app\` | 下载已托管的源码 |
| \`localapp app push --profile online --directory .\` | 上传源码，不自动上线 |
| \`localapp app sync --peer <name>\` | 同步应用到 peer Server |
| \`localapp server [start\\|stop\\|status\\|logs]\` | 管理本机 daemon |
| \`localapp help [command]\` | 查看帮助 |

## 给 AI Agent 的提示

- 先确认用户要修改的应用和需求；在线创建请使用平台的“创建应用”入口。
- 只创建和修改项目目录内的文件；**不要修改、重装或调试全局 localapp CLI、Server 或系统配置**。遇到环境故障（命令不存在、Server 不可达、安装失败）时，停止重试并把错误原样报告用户。
- 临时产物放在项目自己的 \`tmp/\` 目录，不要写系统临时目录。
- 不要实现第二套后端；数据、文件、通知一律使用平台 SDK 与 named SQL。
- 本地验证明确使用 local profile；上传源码使用 online profile。只有用户要求上线时才发布，并从正式路径验收。
`;

export function renderStarterDoc(origin: string): string {
  return STARTER_DOC.replaceAll("{{origin}}", origin);
}

export function starterDocRoutes(app: FastifyInstance): void {
  app.get("/starter.md", async (request, reply) => {
    const origin = `${request.protocol}://${request.hostname}`;
    return reply.type("text/markdown; charset=utf-8").send(renderStarterDoc(origin));
  });
}
