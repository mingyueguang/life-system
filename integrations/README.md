# AI 接入与后续同步

网页登录后，在「账号与 AI 密钥」为每个客户端创建单独密钥，默认只读，可选择读写；界面密钥有效 90 天，仅展示一次，随时可撤销。无需给客户端网站密码。

## 豆包执行接入（1.1.0）

沿用同一页面，选择「仅任务执行（豆包接入）」生成专用密钥。点击「复制新密钥」，在豆包接入测试区选中该客户端、创建测试任务并复制接入说明。无需 SSH 提取凭据。原有读写密钥和业务数据保持不变。

接口基址为站点的 `/api/agent/v1`，所有执行请求使用 `Authorization: Bearer <执行密钥>`。任务按执行密钥 ID 分配，其他执行密钥不能领取或回传它的任务。撤销和到期立即阻止后续调用。

- `GET /health`：公开服务状态，明确标识 simulation_only、model_connected=false。
- `POST /jobs/claim {}`：领取指定给当前密钥的任务；无任务返回 job=null。
- `POST /jobs/:id/heartbeat {lease_token}`：延长领取时效。
- `POST /jobs/:id/result {lease_token,status,output}`：回传结果；模拟成功必须含 output.simulated=true、output.external_effect=false。
- `POST /events {event_id,type:"simulation.feedback",data}`：模拟反馈去重保存。

任务创建、列表及人工核对接口仅供已登录的网站用户，写入要求同源；read/write/worker 密钥都不能创建任务。任务领取有效两分钟；超时在后续请求中标记 needs_review，不自动重试。重复回传相同结果返回 duplicate=true；旧租约和矛盾结果返回 409。当前界面显示最近十条测试任务，并在打开时每十秒刷新。

本版是连接验证，尚未调用模型、创建真实飞书待办或自动同步完成状态。UI 中的 executor 字段是执行端自报，不是身份认证依据；身份由密钥校验。

此前独立 agent-service 的 .env 密钥不再有效，不迁移到网站账号。旧开发服务和模拟数据保留归档，不混入正式业务库。

## HTTP

通过 HTTPS 发送 `Authorization: Bearer <密钥>`，不要把密钥放 URL。

- `GET /api/v1/schema`：先读取字段说明。
- `GET /api/v1/records?kind=account`：读取指定类型；省略 kind 读全部。
- `GET /api/v1/records?since=<UTC ISO>&cursor=<nextCursor>`：增量分页，包含删除标记。
- `POST /api/v1/records`：创建、完整替换更新或软删除。

每页最多 500 条，nextCursor 非空时继续传入，保留原 kind/since。金额为整数「分」，100 元 = 10000。日期 YYYY-MM-DD，日历按中国时区。

```json
{"id":"18f8b131-7cf2-47c1-9c5b-cfcbe46102f8","kind":"account","version":0,"data":{"title":"现金","balance":10000,"note":""},"deleted":false}
```

新建使用新 UUID 和 version=0；更新带最后读到的 version 和完整 data，成功后版本加一。409 需重新读取并核对，不盲目覆盖。软删除用当前版本和完整 data 加 deleted=true。

增量为至少一次语义：同步开始前记录 UTC 时间，分页完成后才推进水位到开始时间；按 ID+version 去重、保留时间重叠，并定期全量核对。分页不是数据库快照。未来飞书适配器可保存 ID 映射、版本和同步水位，目前没有实现自动同步。

## stdio MCP

`mcp-bridge.mjs` 是轻量无依赖桥接，提供 life_schema、life_list、life_save。需 Node.js 24 及支持 MCP 2024-11-05 或兼容协商的客户端。按客户端实际格式配置：

```json
{"mcpServers":{"life-space":{"command":"node","args":["/绝对路径/life-system-portable/integrations/mcp-bridge.mjs"],"env":{"LIFE_SITE_URL":"https://你的域名","LIFE_SITE_ACCESS_TOKEN":"账号页面生成的密钥"}}}}
```

不支持 MCP 的客户端可直接调用 HTTP。读写密钥覆盖全部业务记录，但不能管理账号、密码或其他密钥。
