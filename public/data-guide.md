# 统一数据接口 1.3（开发版，待统一发布）

服务器是共同的数据来源。普通资料读写不需要领取任务或租约。所有调用使用网站现有读写/只读密钥，在 Authorization: Bearer 请求头认证，不回显或保存到业务记录中。

## 开始

先 GET /api/v1/schema。响应提供所有类型的 JSON Schema、metadataSchema、单位和完整示例；以服务器当前格式为准。每个独立 AI 使用自己的密钥。调用者身份由服务器确定，不能用 metadata.source 冒充执行者。

## 写入

POST /api/v1/records，Content-Type: application/json：

```json
{
  "request_id": "123e4567-e89b-42d3-a456-426614174001",
  "id": "123e4567-e89b-42d3-a456-426614174002",
  "kind": "sleep",
  "version": 0,
  "data": {"date": "2026-10-25", "hours": 6.5},
  "metadata": {
    "source": {"method": "user_report", "original_text": "昨晚大约睡了六个半小时"},
    "certainty": "estimated",
    "field_status": {"hours": "estimated"}
  }
}
```

示例编号必须替换为新 UUID。request_id 标识一次逻辑写入，id 标识一条记录，两者用途不同。网络失败重试原请求时，保留相同 request_id 和内容，服务器返回原保存结果并标明 duplicate=true；此结果是原操作的回执，若要获取后来最新版本，应重新 GET 该 id。

新记录 version=0；修改前读取当前 version。服务器会拒绝旧版本覆盖。不要收到 409 后仅改版本号就强行写回；先比较差异。未提供 metadata 时保留原值，显式提供时整体替换，修改某一来源字段前先读取已有 metadata。

数据来源 method：user_report（用户口述）、device（设备）、import（导入）、ai_inference（AI 推断）、unknown（未知）。certainty 与 field_status 区分 reported、estimated、inferred、needs_review、unknown；reported 表示有人报告，不代表独立验证。

未知数值使用 null 或省略可选字段，不填零。不要推断睡眠目标、心情分数或未报告的热量。未知日期留空；occurred_at 仅在有明确时间时填写带时区 ISO 时间。金额为整数人民币分，其他单位以 schema 为准。

## 类型

保留 goal/task/account/debt/repayment/sleep/intake/exercise/subscription；增加 environment、phone_usage、mood、transaction、profile、unclassified。

- profile 用 topic 标明资料主题，statement 保存已知内容；status=known/missing/needs_review。
- 新主题无需立刻新增数据库结构，可先保存为 profile 或 unclassified。不要自创服务器尚不接受的 kind。
- 一段话跨多个领域时，可先用 unclassified 保留原文，再让各条结构记录通过 metadata.related_ids 关联原文记录。字段不确定则标待核实。
- 收支流水与余额分别记录。新增流水不会自动修改账户余额；account_id 仅为关联。
- 手机总计与应用分类分开记录 category；不要把总计再与分类时长相加。

## 查询与接续

- GET /api/v1/records?kind=sleep&from=2026-10-01&to=2026-10-25
- GET /api/v1/records?id=记录UUID
- GET /api/v1/records?kind=profile&status=missing
- GET /api/v1/records?since=带时区ISO时间&cursor=上一页nextCursor

默认返回未归档记录；since 查询包含归档标记。from/to 筛选发生日期，不用写入时间冒充发生时间；未知发生日期的记录不在该日期范围内。日期优先使用 data.date，否则使用 metadata.occurred_at 所带时区的日期部分。

增量同步时：记录本轮开始时间，以固定 since 翻完 nextCursor；下轮从本轮开始时间重叠读取，按 id/version 合并。不能只读取第一页，也不能用本轮结束时间跳过并发写入。

AI 接续沟通前先查询对应 profile 和相关记录；数据来自不同人/设备且存在冲突时保留来源并标记待核实，不自行选择“正确答案”。

## 纠错与历史

仍使用 POST /api/v1/records：同一 id、最新 version 和完整 data。更改类型须 reclassify=true；新类型全部字段通过校验后才保存。归档使用 deleted=true，恢复使用 deleted=false。

GET /api/v1/records?id=UUID&history=true 按版本倒序返回最近100条，使用 nextBeforeVersion 作为 before_version 获取更早历史。旧数据只保留升级时能取得的版本，不伪造此前历史。记录原文、来源的修正同样写入新版本，旧版本仍可查。

## 错误

保留 error 文本，并附 code、details 和 hint。VALIDATION_ERROR 的 details.path 指出字段位置。INVALID_JSON 不回显敏感请求内容；请用 JSON 序列化，不手工拼接 JSON。401/403 检查凭据，409 读取最新状态核对，其他错误报告具体信息。

资料写入不自动触发专业分析，也不要求用户补全所有字段。三个专业 Agent 的访谈和个人计划另行实现。
