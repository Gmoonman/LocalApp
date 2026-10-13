---
name: localapp-upload
description: 在 LocalApp 应用中上传图片、PDF、XLSX，或将平台文件批量打包为 ZIP 下载。用于文件上传和批量导出，不定义业务表、Excel 列或筛选规则。
---

# LocalApp 内容上传

## 概述

平台提供 `useUpload` Hook，让用户可以在前端应用中上传图片、PDF 或 XLSX。内容存储在平台对象存储中，通过返回的 URL 访问。

应用代码应通过 `useUpload()` 上传文件。SDK 从当前应用 resource base 推导上传端点：开发页面使用相对 `/api/content/upload`，正式应用会请求 `/serve/<owner>/<app>/api/content/upload`。Server 返回的 `url` 始终是完整应用作用域 `/serve/<owner>/<app>/api/content/<key>`；直接使用该 URL，不要手工拼接全局 `/api/content/{key}`。

> 应用内容上传的旧 `/api/upload` 别名已移除；应用代码不得调用 `/api/upload`，所有图片、PDF 等内容统一走 `/api/content/upload`。Server 仍可能保留同路径的、经过认证的部署兼容传输，用于把旧 multipart 发布请求规范化为 `.localapp` 后交给正式安装器；它不是应用内容 API，也不是第二套安装实现。

## 限制

- **支持的文件类型**: png、jpg、jpeg、gif、webp、svg、pdf、xlsx
- **单文件最大**: 10MB
- 平台同时验证扩展名、MIME 和文件签名；不能仅修改后缀绕过限制

使用内容能力时，在 `manifest.json` 声明实际需求，例如：

```json
{
  "requires": {
    "content": {
      "mimeTypes": ["image/png", "application/pdf"],
      "maxBytes": 10485760,
      "inlinePreview": ["image/png", "application/pdf"]
    }
  }
}
```

安装前使用 `localapp check --json` 校验声明与实际代码，随后使用 `localapp app install --target <server-profile>`。命令返回正式应用路径后，仍需在 `/<owner>/<app>/` 验证图片/PDF 读取，PDF 场景还应验证完整读取或 Range 请求。

## useUpload() — 上传图片

```tsx
import { useUpload } from "@localapp/sdk-react";

function ImageUploader() {
  const { upload, loading, error } = useUpload();

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const result = await upload(file);
      console.log("上传成功:", result.key, result.url);
    } catch (err) {
      console.error("上传失败:", err);
    }
  };

  return (
    <div>
      <input type="file" accept="image/*" onChange={handleFile} disabled={loading} />
      {loading && <p>上传中...</p>}
      {error && <p>错误: {error.message}</p>}
    </div>
  );
}
```

**返回值:**
- `upload(file: File)` — 上传函数，返回 `{ key: string, url: string }`
- `loading` — boolean，上传中为 true
- `error` — LocalAppError | null，上传失败时的错误信息

**UploadResult:**
- `key` — 文件在存储中的唯一标识（如 `abc123.png`）
- `url` — 文件的访问路径（SDK 自动处理，可直接用作 `<img src={url}>`）

## 常用模式：表单中集成图片上传

上传图片后将 key 存入数据记录，显示图片时使用 `url` 字段构建完整路径。

```tsx
import { useCreate } from "@localapp/sdk-react";
import { useList } from "@localapp/sdk-react";
import { useUpload } from "@localapp/sdk-react";

interface Product {
  id: number;
  name: string;
  imageKey: string;
  imageUrl: string;
}

function ProductForm() {
  const { create } = useCreate<Product>("products");
  const { refresh } = useList<Product>("products");
  const { upload, loading: uploading } = useUpload();
  const [imagePreview, setImagePreview] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const name = (form.elements.namedItem("name") as HTMLInputElement).value;
    const fileInput = form.elements.namedItem("image") as HTMLInputElement;
    const file = fileInput.files?.[0];

    if (!file) return;

    // 1. 先上传图片
    const uploadResult = await upload(file);

    // 2. 创建数据记录，存储图片 key 和 url
    await create({
      name,
      imageKey: uploadResult.key,
      imageUrl: uploadResult.url,
    });

    form.reset();
    setImagePreview(null);
    refresh();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // 预览：使用本地 Object URL
    setImagePreview(URL.createObjectURL(file));
  };

  return (
    <form onSubmit={handleSubmit}>
      <input name="name" placeholder="Product name" required />
      <input name="image" type="file" accept="image/*" onChange={handleFileChange} required />
      {imagePreview && <img src={imagePreview} style={{ maxHeight: 100 }} />}
      <button type="submit" disabled={uploading}>{uploading ? "上传中..." : "添加产品"}</button>
    </form>
  );
}
```

## 显示已上传的图片

数据记录中的 `imageUrl` 可以直接用作 `img` 的 `src`：

```tsx
function ProductList() {
  const { rows } = useList<Product>("products");
  return (
    <div>
      {rows.map(p => (
        <div key={p.id}>
          <img src={p.imageUrl} alt={p.name} style={{ maxHeight: 100 }} />
          <p>{p.name}</p>
        </div>
      ))}
    </div>
  );
}
```

## 错误处理

```tsx
import { LocalAppError } from "@localapp/sdk";

const { upload } = useUpload();

try {
  const result = await upload(file);
} catch (e) {
  if (e instanceof LocalAppError) {
    if (e.status === 400) console.error("不支持的文件类型");
    if (e.status === 401) console.error("需要登录");
    if (e.status === 413) console.error("文件超过 10MB 限制");
    if (e.status === 403) console.error("无权限");
  }
}
```

## 批量导出 ZIP

大量附件应使用平台打包任务，避免先逐个下载到浏览器再生成 ZIP。应用筛选记录、生成 Excel、决定目录和文件名；平台负责文件权限、服务器读取和打包。

```ts
import { createClient } from "@localapp/sdk";
const client = createClient();
const excel = await client.upload(new File([excelBytes], "导出.xlsx", {
  type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}));
const requestKey = crypto.randomUUID(); // 同一次导出的网络重试复用此键
const task = await client.createFileBundle([
  { key: excel.key, path: "汇总/导出.xlsx" },
  ...attachments.map(file => ({ key: file.key, path: `附件/${file.zipName}` })),
], { idempotencyKey: requestKey });
const progress = await client.getFileBundle(task.id);
if (progress.state === "failed") throw new Error(progress.error);
if (progress.state === "completed") client.downloadFileBundle(task.id);
```

页面定时查询进度，显示 `processedFiles / totalFiles` 和失败文件；离开页面时停止查询。不要自动为失败任务换幂等键重试。下载直接使用 SDK 浏览器链接，不用 `fetch().blob()` 接收整个 ZIP。

每项只传上传返回的 `key` 和 ZIP 内的 `path`，不能传服务器路径或 URL。路径不得绝对化、越界或重名；最多 1000 项、原文件总计 2 GiB。结果保留 24 小时且仅创建人登录后可下载。

新文件允许上传者和应用所有者导出，缺少上传者记录的旧文件只允许应用所有者导出。读取生产、写入测试时，可将测试环境新上传的 Excel 与生产附件一起打包。平台会检查文件权限，不要用“记录可见”代替“附件可导出”。
