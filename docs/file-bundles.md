# 文件批量打包下载

应用负责筛选数据、生成 Excel 和决定 ZIP 内名称。平台只接收当前应用的文件 key 和目标路径，不接收本机路径、URL 或 SQL。

```ts
import { createClient } from "@localapp/sdk";
const client = createClient();
const excel = await client.upload(new File([excelBytes], '导出.xlsx', {
  type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}));
// 每次用户主动发起导出生成一个新键；网络重试必须复用该键。
const idempotencyKey = crypto.randomUUID();
const task = await client.createFileBundle([
  { key: excel.key, path: '汇总/导出.xlsx' },
  ...attachments.map(file => ({ key: file.key, path: `附件/${file.zipName}` })),
], { idempotencyKey });
const progress = await client.getFileBundle(task.id);
// 按需轮询，页面离开时停止。不要对失败任务自动生成新幂等键。
if (progress.state === 'failed') throw new Error(progress.error);
if (progress.state === 'completed') client.downloadFileBundle(task.id);
```

HTTP 接口位于应用 API 下：

- `POST /content/bundles`，请求 `{ files: [{ key, path }], idempotencyKey }`，返回 202。
- `GET /content/bundles/:id`，返回任务状态。
- `GET /content/bundles/:id/download`，登录后流式下载 ZIP。

JSON 返回为 `{ success: true, data: ... }`。状态包括 `queued`、`running`、`completed`、`failed`，另有 `processedFiles`、`totalFiles`、`createdAt`、`expiresAt`（毫秒时间戳）、`error`、`failedFile`。失败任务没有可下载的部分 ZIP。同一用户、应用和幂等键复用同一任务；相同键对应不同清单返回 409。

默认最多 1000 个条目、2 GiB 原文件总大小，同时执行 2 个任务，最多 20 个等待或执行任务，每用户最多 3 个，保留的 ZIP 产物总计最多 8 GiB。任务与产物保留 24 小时，定期清理。服务器重启后完成任务继续可下载，未完成任务标记失败，应用可提示用户主动重试。图片、PDF、XLSX、DOCX、PPTX 等直接存入 ZIP，其余文件默认压缩。

文件 key 必须来自当前应用上传返回值。创建及下载均检查应用访问权限，任务状态和结果仅创建人可访问。新文件记录上传者，允许上传者和应用所有者导出；历史文件没有上传者记录，仅应用所有者可导出。此版本尚不提供文件共享授权，不能以业务记录可见来推断附件可导出。

开发预览按“读取数据来源”选择附件。Excel 的上传仍遵循“写入数据来源”；读取、写入环境不同的时候，平台同时检查这两个环境内的文件，因此新生成的 Excel 可以与读取环境中的附件一起打包。隔离验证会话不能创建打包任务。
