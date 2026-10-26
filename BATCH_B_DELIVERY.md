# 批次 B 交付报告 · v1.7.0（2026-10-27）

> 人生系统整改开发计划 · 第 4～5 步交付。基线：批次 A `1ed541b`（v1.6.0）；本批次提交 `2d3702f`。全部实现已在仓库落地并通过全量回归。

## 一、交付结论（先结论）

| 项 | 结果 |
|---|---|
| 协议版本 | 1.7.0（package.json / package-lock / schema / health release / protocol.mjs / ai-guide.md 六处同步） |
| 提交 | `2d3702f` v1.7.0（批次 B），基于批次 A 基线 `1ed541b`，仓库 `life-system-upgrade` 分支 `integrate-agent-execution` |
| 改动规模 | 15 个文件改动 + 1 个新增（`tests/batch-b.test.mjs`），数据迁移 v11 |
| 测试 | 26/26 全绿（批次 B 新增 5 项 + 旧测试 21 项语义同步后全部通过），`next build` typecheck 通过 |
| 验收准则 | 隔离 DB、模拟时钟、明细可查询、状态驱动分析、统一次日统筹、发布回执持久化、单次未完成不废弃、异常只重算受影响领域、防重复待办、幂等重试，逐项通过（见第四节） |

## 二、第四步：状态驱动分析（status-driven analysis）

`server/domain-state.mjs` 的 `assessDomain` 重写为**信号驱动四态**，判定顺序：

1. 关键资料缺失（`required_missing` 非空）→ `insufficient / analyze`（派分析任务补资料并输出候选，缺失不算正常）；
2. 存在待处理调整请求（`plan_adjustments`）→ `adjust / analyze`（成功后请求标记已处理）；
3. 无有效方案或复核时间已到 → `adjust / analyze`；
4. 持久偏离信号（`repeated_skip` ≥2 次 / `time_overrun` 超阈值，按域归类）→ `adjust / analyze`，**只影响受影响领域**；
5. 昨日未完成结转（carryover）→ `attention / reuse`（沿用方案并纳入统筹）；
6. 软信号（`input_drop` / `energy_drop`，阈值来自 `life_settings.auto_adjust`）→ `attention / reuse`；
7. 否则 → `normal / reuse`。

关键改动：

- **每条状态记录持久化 `signals`（来源/规则/结果/说明）与 `pending_adjustments`**，`GET /api/v1/domain-state` 明细可查（迁移 v11：`domain_state_log` 增两列）。
- **单次部分完成/未完成不再废弃领域方案**：删除原阶段 6 在 feedback 处理器里把方案标 `needs_review` 的逻辑，只保留反馈；次日由 `assessDomain` 依据结转与持久偏离信号决定沿用（attention/reuse）还是重算（adjust/analyze），普通波动不触发重算。
- `server/audit.mjs`：`recentSkips` 由计数改为 `{count, domain}`，`repeated_skip` 异常携带 domain，供按域归类。

## 三、第五步：统一次日统筹与外部执行

- **状态机统一判 pending**：`generateIn` 不再自行重复判断待处理调整请求（原逻辑删除），统一以 `assessDomain` 产出的 `pending_adjustments` 为准；**同输入分析复用仅在 `pending_adjustments===0` 时生效**（有调整请求时强制新分析，复用被抑制）。
- **净时间口径**：统筹 role 明确 `available_minutes` 为可分配给清单的净时间（填写时已扣除固定安排），服务器校验"总耗时+机动 ≤ 净时间"，超预算返回 400；执行者不再重复扣减 fixed 文本中的时间。
- **待复盘草案**：当日无复盘且未确认时，统筹 role 追加说明——当前生成的是待复盘草案，复盘返回后如需调整按新版本重新生成，不得静默修改已确认计划；迟到复盘由版本校验（base_version）拒绝。
- **发布回执持久化（外部执行可核对、可恢复）**：
  - 新表 `publish_receipts`（主键 `(user_id,day,action,item_id)`，status ∈ `succeeded` / `unknown`）；
  - `feishu.publish*` 回传结果时：回执返回的项记 `succeeded`；部分成功（`needs_review`）未返回回执或 `publish_missing` 标记的项记 `unknown`（先 DELETE 该批再批量 INSERT，幂等）；
  - 校验放宽：`succeeded` 必须全覆盖且不重复；`needs_review` 允许部分回执 + `publish_missing`（receipts 不得越界到本次发布范围之外）；
  - 新接口 `GET /api/agent/v1/publish-receipts?day=&action=` 明细可查；**恢复时只补缺失事项、不整批重做；重复确认不新建发布批次**（协议 contract 同步新增对应规则）。

## 四、验收准则对照（按对话验收清单逐项核验）

| # | 准则 | 实现与验证 |
|---|---|---|
| 1 | 隔离 DB | 所有测试使用临时目录独立 DB（`setup/closeDb`），互不干扰 |
| 2 | 模拟时钟 | 测试全程注入 `t()` 假时钟；`adjustPlan` 等默认时钟调用在测试中显式传假时间（修复了真实时钟/假时钟错位导致 pending 被过滤的根因） |
| 3 | 正常沿用 | 无信号时 `normal/reuse` 沿用方案（B1 断言 confirmed 计划沿用） |
| 4 | 依赖更新 | 分析输出结构（items/meals/sessions）按域被统筹 `source_id` 校验引用；重算域必须引用本次分析新 session id（测试 `patchNewId` 验证） |
| 5 | 单次未完成不废弃 | B1：单次未完成 `currentPlan` 仍有效、needs_review 数 0、仅结转；stage6 语义同步 |
| 6 | 异常仅分析受影响领域 | B2：`repeated_skip` 只重算健身域，工作/饮食沿用 |
| 7 | 防重复待办 | 同输入分析复用仅 `pending_adjustments===0`；版本校验（base_version）拒绝过期回传；重复确认不新建发布批次 |
| 8 | 幂等重试 | 发布回执 DELETE+INSERT 幂等；`needs_review` 部分成功只补 unknown 项，不整批重做（B4） |
| 9 | 跨月跨年日期 | 日期解析统一 `dateSchema`，`today()` 等按日处理，跨月/跨年不受影响（沿用批次 A 基准） |
| 10 | 净时间预算 | B5：总耗时+buffer 超净时间返回 400 拒绝 |
| 11 | 待复盘草案 | B5：无复盘且未确认时生成草案并标注（summary 注明依据） |
| 12 | 明细可查询 | `GET /domain-state` 含 signals/pending_adjustments；`GET /publish-receipts` 含 succeeded/unknown 明细 |

## 五、测试

- 新增 `tests/batch-b.test.mjs` 5 项：
  - B1 单次未完成不废弃/沿用+结转；
  - B2 repeated_skip 仅重算健身域（工作/饮食沿用）；
  - B3 待处理调整请求触发重算 + pending 明细可查；
  - B4 回执持久化：部分成功只补缺失、不整批重做；重复确认不新建发布批次；
  - B5 净时间预算拒绝 + 待复盘草案标注。
- 旧测试语义同步：integration 版本断言 1.6.0→1.7.0（3 处）；stage6 改为单次未完成 `currentPlan` 仍有效、needs_review 数 0；stage7-A 改为经 `adjustPlan` 申请调整再断言方案标复核（import 增加）。
- 全量：`npm run build && npm test` → **26/26 通过**（含 typecheck）。

## 六、验证方式与缺口

- 验证方式：`node --test tests/batch-b.test.mjs`（5/5）、`npm run build`（typecheck 通过）、`npm test`（26/26）；集成测试需先 build（`.next` 旧构建会导致 release 断言读旧版本）。
- 已知限制（如实说明）：
  - 本批次未包含步骤 6～7（复盘驱动调整与事件驱动长任务）——不在本批次范围；
  - `publish_missing` 由执行者显式标记结果不明事项，服务器不做外部系统探测；`unknown` 恢复仍需执行者先核对外部系统再补发（接口 note 已说明）。
