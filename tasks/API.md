# class-points 轻量版 · API 契约 v1

后端：Node 22 + Express + node:sqlite（内置 SQLite，零第三方 DB 依赖）。
端口 3000，所有 JSON。写操作需请求头 `X-Pin: <PIN>`，错误则 401 `{error:'bad pin'}`。

## 数据模型（SQLite 三张表）

```sql
CREATE TABLE classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#4f8ef7',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE point_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL,          -- 冗余，便于按班拉流
  delta INTEGER NOT NULL,             -- 正加分负扣分
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  undone_at INTEGER                    -- NULL=有效；非 NULL=已撤销
);
```

学生当前分 = SUM(delta WHERE undone_at IS NULL)。撤销不删行（审计保留）。

## 接口

- `GET /api/health` → `{ok:true}`
- `GET /api/classes` → `[{id,name,student_count,created_at}]`
- `POST /api/classes` body `{name}` (PIN) → `{id,name}`
- `GET /api/classes/:id/students` → `[{id,name,color,points}]` points=当前总分（升序按名称）
- `POST /api/classes/:id/students` body `{names:["张三","李四"]}` (PIN) 批量加 → `{added:n}`，颜色自动从 12 色调色板分配
- `DELETE /api/students/:id` (PIN) → `{ok:true}`（级联删事件）
- `POST /api/students/:id/points` body `{delta:5, reason:'回答问题'}` (PIN) → `{id}`（事件 id）；delta 非零整数
- `POST /api/events/:eventId/undo` (PIN) → `{ok:true}`（置 undone_at；已撤销则 409）
- `GET /api/students/:id/events` → `[{id,delta,reason,created_at,undone_at,undoable}]` 倒序，undoable=未撤销
- `GET /api/classes/:id/events` → `[{id,student_id,name,color,delta,reason,created_at,undone_at}]` 倒序 limit 200，用于大屏增量
- `GET /api/events/stream` → **SSE**，`Access-Control-Allow-Origin: *`，`Content-Type: text/event-stream`，心跳注释 30s。事件格式：
  ```
  event: points_changed
  data: {"class_id":1,"event_id":12,"student_id":3,"delta":5,"reason":"回答问题","created_at":1723456}
  ```
  仅加分扣分/撤销触发；携带携带 class_id 大屏过滤。

## 其他要求

- CORS：`Access-Control-Allow-Origin: *`，允许 `X-Pin,Content-Type` 头，OPTIONS 200
- PIN 从 `process.env.PIN_CODE` 读（默认 '1234'），恒定时间比较
- 静态目录：`server/public`（Express 托管，健康检查页即可）
- 端口 `process.env.PORT || 3000`
- SQLite 文件：`DATA_DIR` 环境变量或 `server/data/`，WAL 模式
- 依赖仅 `express`；Node >= 22（node:sqlite 内置）