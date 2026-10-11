# dsh 文档扩展

提供 MarkItDown、PDF、DOCX、XLSX 公共 Skills，以及依赖状态检查和按选择准备 Skills 的服务。不依赖 LocalApp 账号、应用托管或开发项目。它使用调用方提供的环境检查结果；多人部署中的身份、应用权限和管理员 Python 环境仍由宿主处理。

```ts
import DocumentTools from "@localapp/dsh-document-tools";
await ctx.plugin(DocumentTools);
const catalog = ctx.localappDocuments.catalog(environmentReport);
const skillDirectory = ctx.localappDocuments.prepare(workspace, ["pdf"], environmentReport);
```

将返回目录加入 dsh skill-filesystem 的 `customSkillDirs`。只有依赖就绪的已选 Skills 会进入工作区。停止插件后不能再查询或准备 Skills。宿主可通过 `onStop()` 关闭使用这些 Skills 的 Agent；LocalApp 已接入该回调，只关闭公共文档 Skills 的运行时，并保留其他工作区与会话历史。重新启用扩展后会重新检查依赖并恢复有效选择。

每套 Skill 的来源、固定版本、许可证及本地改动记录保存在 `skills/<name>/SOURCE.json` 和 `LICENSE`。统一 LocalApp npm 包包含该插件与完整资源。

LocalApp 的 `createPluginSuite` 默认加载此扩展；宿主可传入 `documents: false` 省略扩展，或 `documents: { root: "/absolute/skills/path" }` 指定资源目录。省略扩展后普通 Agent、应用平台和开发插件仍可加载；用户已保存的文档 Skills 选择保留，但会显示为不可用。此选项是宿主组装接口，尚不是管理员设置页的开关。
