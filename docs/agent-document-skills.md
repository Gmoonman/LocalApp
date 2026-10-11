# 应用 Agent 的 Skills 和工具设置

LocalApp 随 Server 提供四个公共文档 skill：MarkItDown、PDF、DOCX 和 XLSX。来源、固定 commit、许可证和 LocalApp 的改动记录分别保存在 `packages/dsh-document-tools/skills/<name>/SOURCE.json` 与 `LICENSE` 中；发布包包含完整 instructions、scripts 和 references。

应用在 manifest 声明所需能力，例如：

```json
{ "agent": { "capabilities": ["files", "terminal", "skills"] } }
```

用户在应用设置页的 **Agent** 标签，或应用聊天区的 **应用 Agent 设置** 入口，选择自己的能力、公共 skills 和工具。其他用户分别保存自己的选择。公共 skills 默认不启用；能力仍需应用声明并经当前用户启用。已有工作区 `skills/` 中的自定义 skills 保持原有加载方式。

关闭单个工具后，Server 从模型可见的工具列表中移除它，并阻止直接调用。应用工具在应用注册工具时同步到当前用户的设置列表；旧版应用首次发起请求后也会同步。选择新能力并保存后，会列出相应 DSH 工具。更改设置会关闭该应用当前用户的 Agent 实例，下一次请求使用新配置；对话仍然保留。

模型供应商、凭据和 MCP 连接仍在 **模型与 Agent** 页配置。保存供应商不会覆盖应用的 Skills 和工具选择。

## 文档运行环境

Skills 的 Python 脚本已包含在包内，Python、第三方 Python 库、LibreOffice 和 Poppler 不随 npm 包提供。启用 skill 不等于这些依赖已安装。需要 Python 3.10+，并且该 Python 的安装目录必须能被现有应用终端沙箱读取。脚本、输入文件、输出文件、缓存和虚拟环境都在当前用户的应用工作区内运行。

可在工作区创建虚拟环境后安装需要的库：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install 'markitdown[pdf,docx,xlsx]==0.1.8' pypdf reportlab pdfplumber python-docx openpyxl
```

Windows 的虚拟环境命令路径为 `.venv/Scripts/python.exe`，但当前终端能力仍取决于 Server 是否支持文件读取隔离。不得为了运行文档脚本绕过沙箱。

PDF、DOCX、XLSX skill 中的 `scripts/` 路径相对于 skill 目录，例如 `.localapp-public-skills/pdf/scripts/pdf_read.py`。优先提取本地文本和表格；扫描件需要 OCR，文档视觉检查需要页面渲染与可用的图片理解工具。外部 OCR、云转换和额外模型服务不会自动配置。

本次接入公共 skills 和设置选择，不增加聊天附件上传或模型图片输入传输。文件需已在 Agent 工作区内；这些传输能力需要另外接入。

### 系统文档处理环境

文档 Skills 由 LocalApp 提供。管理员在“系统设置 → Python 环境”检查全部文档 Skills 的 Python 3.10+ 和依赖，结果适用于所有用户和应用。普通用户不能访问系统检查接口或查看解释器路径；应用设置只显示 Skill 是否可用。

检查使用 Server 的 DSH 工作区执行器，不安装软件或请求模型，不依赖用户的模型配置。结果缓存 15 秒。依赖缺失时，应用内无法开启对应 Skill；后端保存时同样校验，并从 Agent 实际加载的列表中移除依赖失效的 Skill。

检查在同一个 Python 中导入依赖，不拼接不同解释器的依赖。PDF 渲染、LibreOffice 等可选依赖单独显示，不阻止基本 Skill 开启。环境就绪不代表附件上传、OCR 或真实文档处理已经通过验证。

### 通用 Python 虚拟环境

管理员可以选择已有 venv 的 Python 绝对路径，或指定 Python 3.10+ 的基础解释器创建 LocalApp 专用 venv。配置属于 Server，供所有应用的 Python 脚本共用，不限于文档处理。专用环境放在 `dataDir/python-environments/<id>`；配置保存在 `dataDir/python-environment.json`。

创建环境默认不安装文档库，可明确勾选安装，或稍后使用“安装文档 Skills 依赖”。安装只修改选定的虚拟环境，不向系统 Python 安装包。新建不覆盖现有目录；创建或安装失败不会替换当前环境。

执行器向命令提供虚拟环境的 PATH 和 VIRTUAL_ENV，并向模型说明解释器路径。环境及基础 Python 安装目录仅允许读取；应用工作区是可写目录，其他 Server 数据仍不能读取。配置变更后的后续 Agent 请求会重新创建运行时，使用新环境；环境检查只使用选定的解释器，不回退到其他 Python。
