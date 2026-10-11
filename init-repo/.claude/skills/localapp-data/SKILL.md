---
name: localapp-data
description: >
  LocalApp 数据操作指南——Schema CRUD、backend named SQL、React SDK Hook 用法。
  当用户要在 LocalApp 项目中使用数据存储、定义数据表、注册后端 SQL 查询、
  使用 useList/useCreate/useUpdate/useDelete/useGet/useCount/useQuery/useMutation 等 Hook 时触发。
  也适用于用户说"加个数据表"、"存储数据"、"查询数据"、"创建 schema"、
  "用数据库"、"CRUD"、"增删改查"等场景。
---

# LocalApp 数据操作

LocalApp 提供内置 SQLite 数据库，两种生产推荐方式：声明式 CRUD 和 backend named SQL。

## 模式选择

```
需求复杂度
    低 ──────────────────── 高
    │                        │
    ▼                        ▼
 CRUD 模式               backend named SQL
 (零后端代码)           (注册 SQL)
    │                        │
    │  也可以混合使用          │
    └─── backend 查询 ───────┘
         复杂查询
```

- **CRUD 模式**：写 SQL migration 创建表 → 自动获得 REST API + React Hook。适合简单增删改查。
- **backend named SQL**：把 JOIN、聚合、子查询等复杂操作注册到 `backend/resources/<resource>/queries.json` 或 `mutations.json`，前端只调用名字和参数。
- **混合**：CRUD 模式负责常规资源操作，复杂查询用 `client.query()` / `client.mutate()` 或 React hooks 调用注册 SQL。

## CRUD 模式

### SQL migration 流程

1. 在 `migrations/001_<description>.sql` 中写 SQLite DDL。
2. 运行 `localapp db reset` 重建项目 `tmp/localapp-schema/schema.db` 下的离线 schema 工作库。
3. 运行 `localapp db types -o src/types.ts` 从该工作库生成类型；它不承载运行时应用数据。
4. 安装前运行 `localapp db validate`，通过后再 `localapp app install --target <server-profile>`。

示例：
```sql
CREATE TABLE posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  views INTEGER NOT NULL DEFAULT 0,
  published INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

字段结构只由 SQL migration 管理；`manifest.business` 用于声明 ownerField、recordAccess、transitions、defaultFields、enums 等业务规则。

#### 当前用户默认值 `defaultFrom`

让后端在创建记录时自动填充当前用户字段，避免前端伪造：

```json
{
  "business": {
    "leaves": {
      "defaultFields": {
        "created_by": { "defaultFrom": "currentUser.id" },
        "reviewed_by": { "defaultFrom": "currentUser.name" }
      }
    }
  }
}
```

支持值：
- `"currentUser.id"` — 当前用户 ID
- `"currentUser.name"` — 当前用户显示名

请求体中显式传入同名字段会被后端覆盖（防伪造）。未登录用户创建包含 `defaultFrom` 的记录会返回 401。

#### 字段枚举 `enum`

限制字段只能取预设值，常配合状态字段使用：

```json
{
  "status": {
    "type": "string",
    "constraints": {
      "defaultValue": "draft",
      "enum": ["draft", "submitted", "approved", "rejected"]
    }
  }
}
```

传入 `enum` 外的值会被后端拒绝并返回 400。

#### 业务模型元数据 `business`

在 `manifest.business.<table>` 声明业务约定：

```json
{
  "business": {
    "leaves": {
      "ownerField": "created_by",
      "statusField": "status",
      "enums": { "status": ["draft", "submitted", "approved"] },
      "recordAccess": { "read": "owner", "update": "owner" }
    }
  }
}
```

`business` 字段含义：
- `kind`：业务形态（`request` / `assignment` / `catalog` / `personal`），主要供 Agent 参考
- `ownerField` / `assigneeField` / `aclField`：记录归属字段名
- `statusField` + `statuses`：状态字段名和合法值
- `recordAccess`：按动作（read/create/update/delete）声明记录级策略

#### 记录级访问控制 `recordAccess`

后端 CRUD API 自动执行，前端无法绕过。支持四种模式：

| 模式 | 语义 |
|------|------|
| `authenticated` | 登录即可 |
| `ownerField` | 记录所有者（`record[field] === currentUser.id`） |
| `assigneeField` | 被分配人 |
| `aclField` | ACL 字段包含当前用户 |

附加 `when` 限制状态：
```json
"update": {
  "mode": "ownerField",
  "field": "created_by",
  "when": { "status": ["draft"] }
}
```
表示"所有者且状态为 draft 时才能更新"。

页面所有者（page owner）始终绕过记录级策略。详细约定和模型选择见 `localapp-business.md`。

**重要**：生产应用不要把 SQL 文本写进前端。涉及业务权限或复杂查询时，优先使用 CRUD API 或 backend named SQL；由后端执行权限检查并注入 `currentUserId`、`ownerId`、`now` 等系统参数。

#### 业务状态变化用 transition mutation（不要用 useUpdate）

如果业务模型有"状态"概念（如请假 draft→submitted→approved、任务 todo→done），**不要用 `useUpdate` 改 status 字段**——前端可以任意改状态，绕过了状态机的合法性。

正确做法：在 schema `business.transitions[]` 中声明合法迁移（前端 UI 元数据），在 `backend/resources/<table>/mutations.json` 声明对应的 named mutation（实际执行入口），前端用 `useTransitions()` Hook：

```tsx
import { useTransitions } from "@localapp/sdk-react";
import type { BusinessMetadata } from "@localapp/sdk-react";

const leaveSchema: BusinessMetadata = {
  statusField: "status",
  transitions: [
    { name: "submit", label: "提交", from: ["draft"], to: "submitted" },
    // ...
  ],
};

const { transitions, transition } = useTransitions("leaves", leave, leaveSchema);
// transitions: 当前可用动作（根据 record.status 和 schema.transitions[from] 本地过滤）
// transition(name): 调用 mutate('$leaves.<name>', { id: leave.id, ...payload })
```

详细 transition 建模规则和 named mutation SQL 模板见 `localapp-transitions.md`。

### named SQL API（应用层唯一数据通道）

应用层数据读写**只**通过 named SQL 端点：

```
POST   /api/queries/$<resource>.<action>     执行声明的 named query
POST   /api/mutations/$<resource>.<action>   执行声明的 named mutation
```

应用必须在 `backend/resources/<resource>/{queries,mutations}.json` 中声明所有数据操作。
SDK helper 内部调用对应的 named SQL：

| SDK 调用 | 内部命名 SQL |
|---------|-------------|
| `client.list(resource)` | `$<resource>.list` |
| `client.get(resource, id)` | `$<resource>.get` |
| `client.count(resource)` | `$<resource>.count` |
| `client.create(resource, data)` | `$<resource>.create` |
| `client.update(resource, id, data)` | `$<resource>.update` |
| `client.delete(resource, id)` | `$<resource>.delete` |

未声明对应 named SQL 时，helper 直接抛 `LocalAppError`——不再 fallback 到 REST CRUD。

> **REST CRUD 端点（`GET /api/<resource>`、`POST /api/<resource>`、`GET /api/<resource>/:id`
> 等）已随 restrict-app-api-to-named-sql 变更整体移除。** 应用必须显式声明 named SQL
> 才能暴露数据操作。

列表查询参数：
```
?offset=0&limit=10&sort=created_at&order=desc&status=published
```

筛选运算符（追加 `__operator` 后缀到字段名）：
```
status=published          精确匹配（默认）
priority__gte=3           大于等于
priority__lte=5           小于等于
priority__gt=1            大于
priority__lt=10           小于
status__ne=closed         不等于
title__like=%bug%         模糊匹配（LIKE）
```

### React SDK Hook

所有 Hook 从 `@localapp/sdk-react` 导入：

#### useList(resource, options?)
```tsx
const { rows, pagination, loading, error, refresh } = useList<Post>("posts", {
  filters: { status: "published" },
  offset: 0,
  limit: 10,
  sort: "created_at",
  order: "desc",
});
// rows: T[]
// pagination: { offset, limit, total }
// refresh: () => Promise<void>  手动刷新
```

DevShell 中切换身份、固定时间、reset 或 restore snapshot 后会派发 `localapp:dev-context-changed`，`useList` / `useGet` / `useCount` 等订阅型 hooks 会自动刷新当前资源。验证 `recordAccess` 时，直接在 Dev Toolkit 的 Identity 里切换用户，再观察列表和详情是否变化。

#### useGet(resource, id)
```tsx
const { row, loading, error } = useGet<Post>("posts", 1);
// row: T | null
```

#### useCreate(resource, options?)
```tsx
const { create, loading, error } = useCreate<Post>("posts", { onSuccess: () => refresh() });
const newPost = await create({ title: "Hello", content: "World" });
// 返回创建的记录（含 id）
// loading: boolean — 调用中为 true
// error: LocalAppError | null — 失败时设置（同时 throw）
```

#### useUpdate(resource, options?)
```tsx
const { update, loading, error } = useUpdate<Post>("posts", { onSuccess: () => refresh() });
const updated = await update(1, { title: "Updated" });
```

#### useDelete(resource, options?)
```tsx
const { remove, loading, error } = useDelete("posts", { onSuccess: () => refresh() });
await remove(1);
```

#### useCount(resource, filters?)
```tsx
const { count, loading, error, refresh } = useCount("posts");
const { count: published } = useCount("posts", { status: "published" });
// refresh: () => Promise<void>  手动刷新计数
```

需要判断资源数量时，优先使用 `client.count()` 或 `useCount()`。不要把 `list({ limit: 1 })` / `list(limit: 1)` 当作常规计数写法；它只属于旧运行时兼容兜底，应用代码不应主动依赖这种绕法。

## Backend named SQL

复杂查询和自定义写入应注册为 backend 契约文件，而不是让前端提交任意 SQL。

示例目录：
```
backend/
  resources/
    posts/
      schema.json
      queries.json
      mutations.json
```

每条 named query 和 mutation 都必须声明 `security`，否则 `localapp check` 会拒绝。
手写 SQL 使用 `mode: "custom"`；以下示例适用于登录用户操作自己的 notes：

```json
"security": {
  "mode": "custom",
  "access": "authenticated",
  "resources": ["notes"],
  "systemParams": ["currentUserId"],
  "scenarios": [
    { "identity": "anonymous", "expect": "deny" },
    { "identity": "owner", "expect": "allow" },
    { "identity": "member", "expect": "allow" }
  ]
}
```

`resources` 列出 SQL 中使用的表；`systemParams` 必须与 SQL 中实际使用的平台参数完全一致，未使用时填 `[]`，使用 `:now` 时也列出 `"now"`。顶层 `access` 与此例都为 `"authenticated"`。
`scenarios` 是预期行为说明，不会自动过滤数据。个人数据的 SELECT、UPDATE、DELETE 必须包含 `WHERE created_by = :currentUserId`，INSERT 写入平台注入的 `:currentUserId`；前端不得传入其他用户身份。必须实际测试另一用户看不到、删不掉当前用户的记录。
模板中的 `mode: "generated"` 带有绑定 SQL 的 digest；不要复制 digest 后修改 SQL，手写操作使用上述 custom 声明。

`queries.json` 示例：
```json
{
  "$schema": "https://localapp.dev/schemas/backend/queries.schema.json",
  "queries": {
    "posts.popular": {
      "kind": "query",
      "sql": "SELECT id, title, views FROM posts WHERE views >= :minViews ORDER BY views DESC LIMIT :limit OFFSET :offset",
      "params": {
        "minViews": { "type": "number", "required": true },
        "limit": { "type": "number", "required": true },
        "offset": { "type": "number", "required": true }
      },
      "result": { "mode": "page", "maxRows": 100, "maxBytes": 65536 },
      "access": "authenticated",
      "security": {
        "mode": "custom",
        "access": "authenticated",
        "resources": ["posts"],
        "systemParams": [],
        "scenarios": [
          { "identity": "anonymous", "expect": "deny" },
          { "identity": "owner", "expect": "allow" },
          { "identity": "member", "expect": "allow" }
        ]
      }
    }
  }
}
```

前端调用：
```tsx
import { useQuery, useMutation } from "@localapp/sdk-react";

const { query } = useQuery();
const popular = await query("posts.popular", { minViews: 100, limit: 20, offset: 0 });

const { mutate } = useMutation();
await mutate("posts.publish", { id: postId });
```

也可以直接用 core SDK：
```ts
const result = await client.query("posts.popular", { minViews: 100, limit: 20, offset: 0 });
await client.mutate("posts.publish", { id: postId });
```

系统参数由后端注入，前端不能覆盖：
- `:currentUserId`
- `:ownerId`
- `:now`

> **没有 raw SQL 端点**——`useExec` Hook 和 `client.exec()` 方法已随 restrict-app-api-to-named-sql
> 变更整体移除。所有数据操作必须声明为 named SQL，通过 `client.query()` / `client.mutate()`
> 或对应的 React Hook 调用。开发期需要直接观察数据库时，开发者可以直接操作 SQLite 文件。

## 常见模式

### 列表 + 创建表单
```tsx
function TodoApp() {
  const { rows, loading, refresh } = useList<Todo>("todos");
  const { create } = useCreate<Todo>("todos");

  const handleAdd = async (title: string) => {
    await create({ title, done: false });
    refresh();
  };

  if (loading) return <p>加载中...</p>;
  return (
    <div>
      <form onSubmit={async (e) => {
        e.preventDefault();
        const input = (e.target as HTMLFormElement).elements[0] as HTMLInputElement;
        await handleAdd(input.value);
        input.value = "";
      }}>
        <input name="title" required />
        <button type="submit">添加</button>
      </form>
      <ul>{rows.map(t => <li key={t.id}>{t.title}</li>)}</ul>
    </div>
  );
}
```

### 主从关系（两张表关联）
```sql
CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL);
CREATE TABLE comments (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL, content TEXT);
```

```tsx
function PostWithComments({ postId }: { postId: number }) {
  const { row } = useGet("posts", postId);
  const { rows } = useList("comments", { filters: { post_id: postId } });

  return (
    <div>
      <h1>{row?.title}</h1>
      {rows.map(c => <p key={c.id}>{c.content}</p>)}
    </div>
  );
}
```
