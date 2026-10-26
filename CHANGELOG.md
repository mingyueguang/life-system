# 1.8.0 · 2026-10-27（批次 C：接口当前/历史分离 / 设置入口 / 版本区分 / 备份恢复与整体验收）

- **接口"当前状态 vs 历史判断"分离（第六步）**：`GET /api/v1/domain-state` 返回 `{current,domains}`——`current` 为服务器按最近一次生成日判定的最新四态（仅当前判断），`domains` 为查询结果（含历史记录与 signals/pending_adjustments 明细，按日可查）；`GET /api/v1/plans` 返回 `{current,plans}`——`current` 为各域 `currentPlan` 有效方案（confirmed 且未过复核期），`plans` 为全部版本历史。客户端 KPI/面板只消费 `current`，历史判断仍可完整追溯。
- **设置入口恢复（正常导航可访问）**：新增 `GET /api/agent/v1/settings`（返回 `life_settings`，AI/网站同源）；网站"今日方案与提醒"设置表单补齐"异常阈值与结转"区——三域复核周期（`domain_review_days`）、超时/精力骤降阈值与未完成结转开关（`overrun_factor`/`energy_drop_threshold`/`skip_carryover`，1.4.2 已有字段补全 UI）。
- **应用版本与协议版本区分**：`GET /api/agent/v1/health` 改为 `{app_version:"1.8.0",protocol_version:"1.8.0"}`（`app_version` 来自应用包版本，`protocol_version` 来自 `server/protocol.mjs`；不再使用含义模糊的 `release`）。系统面板 KPI 同步改用两字段；schema 文档与 ai-guide 同步。
- **备份恢复精确比对（可演练）**：`scripts/backup.mjs` 使用 SQLite 在线 `backup()`（不复制使用中的主库文件），关闭在线连接后以备份文件重开；`tests/backup.test.mjs` 对 12 张表（users/api_keys/executors/life_settings/records/domain_plans/plan_adjustments/daily_days/agent_jobs/publish_receipts/domain_state_log/raw_inputs）做全量 JSON 精确比对 + 恢复后服务可查断言，作为备份恢复演练基准。
- **整体验收串场（六步验收清单自动化为测试）**：`tests/batch-c.test.mjs` 单文件 9 阶段串场——部分资料提问→AI 接续不重复问→换执行者接续→三域具条件→连续数日沿用→改可用时间+执行中分析→依赖更新拒绝过期结果→单次未完成不废弃→调整请求只分析受影响域（原因/处理人不丢失）→确认后发布（部分成功只补缺失、重复确认不新建批次）→回传丢失 active 恢复（执行者更换拿不到他人任务、重启后状态保持）→同输入复用不重复派发分析、不推进版本。
- 协议版本 1.8.0（package.json / package-lock / schema protocolVersion / health app_version+protocol_version / protocol.mjs / ai-guide.md 六处同步）；`app_version` 与 `protocol_version` 解耦声明。
- 测试：新增备份精确比对 1 项 + 整体验收串场 1 项；集成测试 health 版本断言同步（release→app_version+protocol_version）。28/28 通过，typecheck 通过。部署交接（DEPLOYMENT.md）补充恢复后 12 表核对指引。

# 1.7.0 · 2026-10-27（批次 B：状态驱动分析 / 统一次日统筹与外部执行）

- **第四步：状态驱动分析（domain_state 四态 + 信号持久化）**：`assessDomain` 按信号规则确定性推导四态——关键资料缺失→`insufficient/analyze`；待处理调整请求→`adjust/analyze`；无有效方案或复核到期→`adjust/analyze`；持久偏离（重复跳过 / 按域超时）→`adjust/analyze`（只影响受影响领域）；昨日未完成结转→`attention/reuse`；精力骤降等软信号→`attention/reuse`；否则 `normal/reuse`。判定顺序先于旧的 needs_review 启发式。每条记录写入 `signals`（来源/规则/结果/说明）与 `pending_adjustments`，`GET /api/v1/domain-state` 可查；单次未完成只结转不废弃领域方案（原阶段 6"未完成即标 needs_review"逻辑删除，由次日状态机统一决定沿用/重算）。
- **第五步：统一次日统筹与外部执行**：`generate` 不再自行重复判 pending（由状态机统一），同输入分析复用仅在 `pending_adjustments===0` 时生效；统筹 role 明确 `available_minutes` 为可分配给清单的净时间（固定安排已扣除，不要重复扣减），服务器校验总耗时+机动≤净时间；今日复盘未返回时生成"待复盘草案"（summary 注明依据），迟到复盘由版本校验拒绝、不得静默修改已确认计划。
- **发布回执持久化（外部执行可核对、可恢复）**：`feishu.publish*` 回传结果时持久化 `publish_receipts`（user_id/day/action/item_id 主键，status ∈ succeeded/unknown）：回执返回的项记 succeeded；部分成功（needs_review）未返回回执或 `publish_missing` 标记的项记 unknown。校验放宽：succeeded 必须全覆盖且不重复；needs_review 允许部分回执 + publish_missing（回执不得越界到本次发布范围之外）。新接口 `GET /api/agent/v1/publish-receipts?day=&action=`。恢复时只补缺失事项、不整批重做；重复确认不新建发布批次。
- 数据迁移 v11（增量、兼容）：domain_state_log 加 signals、pending_adjustments 列；新建 publish_receipts 表与查询索引。
- 协议版本 1.7.0（package.json / package-lock / schema protocolVersion / health release / protocol.mjs / ai-guide.md 同步）；publish 契约新增部分成功与恢复规则。
- 测试：新增批次 B 专项测试 5 项（单次未完成不废弃/沿用+结转、repeated_skip 仅重算受影响域、待处理调整请求触发重算+pending 可查、回执持久化+部分成功不整批重做+重复确认不新建发布批次、净时间预算拒绝+待复盘草案标注）；旧测试同步（版本断言 1.7.0、stage6 单次未完成不废弃、stage7 经 adjustPlan 申请调整触发重算）。26/26 通过，typecheck 通过。

# 1.6.0 · 2026-10-26（批次 A：任务依赖 / 资料门槛 / 方案生命周期）

- **任务生成与依赖修复（第一步）**：生成前按输入指纹（records_version）查找该日同输入的分析任务——进行中或已完成的分析直接作为本次统筹的前置依赖复用（不重复派发）；输入已变化时先失效旧版统筹与分析任务（旧执行者回传被版本校验拒绝，不会回写）。去掉按天粗粒度去重导致的"新统筹失去前置依赖"问题；"正在分析/已有有效方案/资料不足"由领域状态规则独立判定。
- **资料门槛与方案来源（第二步）**：统一资料准备状态计算入口（intake.intakeStatus，替代 life.mjs 内重复实现，规划/领域状态/确认/展示同源）；关键资料缺失（required_missing）的领域事项只能作为候选放入 deferred，服务器校验禁止其进入正式执行清单（daily.plan 回传 400、确认 409 双保险）；工作方案输出改为有稳定 ID 的结构化事项（items），可被统筹 source_id 引用，不再用字符串建议承担来源。
- **方案生命周期与调整请求（第三步）**：调整请求持久化（plan_adjustments：原因/提出者/时间/关联版本/处理状态），下一轮分析携带未处理请求并说明处理，成功后标记 handled；每域仅一个当前有效方案（确认时存在更新版本返回 409）；方案落库记录依据指纹 basis_hash，确认前资料已变化返回 409；需复核/过期方案确认=继续沿用并记录新有效期（按域复核周期）；复核周期可配置（settings.domain_review_days，默认 7 天/域）；currentPlan 等有效期判断改用可注入时钟。
- 数据迁移 v10（增量、兼容）：domain_plans 加 basis_hash 列；新增 plan_adjustments 表与索引。既有数据无需回填（basis_hash 为 null 时跳过依据校验）。
- 新接口：`GET /api/v1/plans/adjustments?domain=&status=`（调整请求查询，跨重启可读）。
- 协议版本 1.6.0（package.json / package-lock / schema protocolVersion / health release / protocol.mjs / ai-guide.md 同步）；analysis.work 输出结构变更（items 替代 recommendations），契约成功示例与规则同步。
- 测试：更新全部 work 输出结构用例，新增批次 A 专项测试（同输入复用/输入变化失效、资料不足域拦截、确认并发与依据校验、调整请求持久化与读取）。20/20 通过，typecheck 通过。

# 1.5.0 · 2026-10-26

- **单次授权即全权限（AI 对话为主线）**：已登记执行者持读写密钥即获得完整操作权限，不再按操作单独授权——确认/撤回计划（daily/update confirm|reopen）、修改系统设置（settings，含飞书开关）、确认领域方案（plans/confirm）、核实 AI 提取信息（records/review）、确认资料整理建议（intake accept_evidence）全部开放 AI 通道；原"仅网站会话/仅网站核对"的 403 拦截移除。
- **全量审计替代逐次审批**：每次写操作记录执行者（密钥标识或 website）——计划确认/撤回写入 agent_audit（day.confirm:actor / day.reopen:actor），设置修改写入 agent_audit（settings.update:actor），方案确认写入 agent_audit（plan.confirm:actor），资料整理确认写入 agent_audit（intake.accept_evidence:actor），记录核实写入 metadata.review.actor。事后可查、可追溯，用户不要求网站参与日常确认。
- **契约自描述增强（AI 不猜格式）**：protocol 新增 error_catalog（9 个错误码的机器可读含义与修正指引）、每个 action 的 contract 附 lease_seconds 与 external_effect；ai-guide.md 新增"错误码与处理"表与"认证与单次授权"说明；schema 文档同步去除"仅网站登录用户"表述。所有失败响应保持结构化 JSON（error/code/details/hint）。
- 协议版本 1.5.0（package.json / package-lock / schema protocolVersion / health release / protocol.mjs / ai-guide.md 同步）。
- 测试：集成测试覆盖 AI 通道 settings/plans/confirm/records/review/accept_evidence、契约 error_catalog 与 lease、执行者审计留痕；持久化断言改为按记录 ID 匹配。20/20 通过，typecheck 通过。

# 1.4.2 · 2026-10-25

- 心情日记、手机使用、环境记录进入分析上下文：三域分析与统筹能看到空气质量、手机时长与心情自评，为"今天是否该减量"提供输入；移除无效的 diet 记录类型引用（饮食摄入由 intake 承担，饮食方案存于 daily_days.diet）。
- 自动调整策略可配置（life_settings.auto_adjust）：超时提醒阈值、精力骤降阈值、未完成结转开关，网站"今日方案与提醒"内即时保存；阈值只影响提醒，不自动改已确认计划。
- 网站新增"资料收集进度"入口：展示工作/健身/饮食三域已确认/待补/暂缓/待核实计数与建议继续询问的问题（复用 GET /api/v1/profile）。
- overview 返回 carryover（昨日未完成结转清单），网站同步展示。
- 版本统一 1.4.2（package.json / package-lock / schema / health / protocol）；审计阈值参数化并有对应测试。
- 飞书三域独立发布：新增协议动作 `feishu.publish.fitness` / `feishu.publish.diet`，确认计划且启用飞书时，整日计划、训练方案、饮食方案各自独立发布，各自回执校验（receipts 覆盖 sessions/meals id，缺失或重复 400）。

# 1.4.1 · 2026-10-25

- 饮食历史数据进入 records() 分析上下文（analysis.diet 排方案可参考摄入记录）。
- 未完成结转（carryover）：近 7 天 skipped/partial 事项自动进入次日统筹候选，避免无限拖延；统筹文案明确优先纳入结转事项。
- 三域方案保存：迁移版本 7，daily_days 增加 fitness/diet 列；analysis.fitness/analysis.diet 成功回传后写入（不 bump 主版本号，避免破坏统筹 base_version）。
- 网站"今日方案与提醒"入口：展示异常提醒、数据核对清单、今日训练方案与今日饮食方案。

# 1.4.0 · 2026-10-25

- 计划生成前数据核对（server/audit.mjs）：已完成/过期记录进入核对清单；硬拦截仅保留结构化证据（task_id 指向已完成待办），标题匹配一律软核对，周期事项照常安排。
- 三域方案：新增 analysis.fitness（训练 sessions 含时长）与 analysis.diet（饮食 meals）任务及各自输出 schema；daily.plan 统筹依赖工作/健身/饮食三域分析。
- 每晚自动统筹次日计划草案：综合三域方案形成单一清单（总时长+机动≤已知可用时间、可用时间未知列 missing、关联待办未完成校验、业务数据变化 409）。
- 日常异常判断（确定性规则，无 AI 参与）：可用时间骤降、精力骤降、重复跳过、严重超时；信号注入复盘与统筹上下文并经 overview 暴露，仅请求确认、不自动改计划。
- 协议 protocolVersion 1.4.0；移除时间槽与重叠检查（系统不预设两件事能否同时做），计划草案不等同于日程。
- 迁移版本 6 已含原始资料与来源追踪；审计与异常判断全部本地确定性实现。

# 1.3.0 — 共享档案与原始资料层（本阶段：数据基础 + 资料收集流程）

- 新增原始资料实体 `raw_inputs`：一份输入可提取为多条结构化记录，共享同一 `source_id`；记录仍保留来源、原文、版本、核实状态与修改历史。
- 统一数据 API 扩展：`POST/GET /api/v1/sources`、`GET /api/v1/sources/:id`（原始资料与关联记录）、`GET /api/v1/profile`（任意 AI 的档案接续入口）、`POST /api/v1/records/review`（用户确认/否定 AI 推断，仅网站登录）。
- 记录查询支持按原始资料（`?source=`）与关联目标（`?related=`）过滤；`metadata.review` 记录确认/否定、执行者与时间。
- 资料收集支持一次回答多个问题（`answer_many`），分次回答、暂缓、恢复与已有资料整理核对沿用原流程。
- 租约与任务系统沿用并验证：独占领取、live 任务 10 分钟租约、心跳 30 秒、`/jobs/active` 凭据恢复；普通数据读写/档案查询不占用租约。
- 网站新增“原始资料”与“待核实与推断”入口；沿用现有面板与交互组件。
- 数据库迁移版本 6（纯增量，兼容既有数据）；新增 profile 接口测试与原始资料/复核测试。

# 版本记录

## 1.2.0 · 2026-10-25

- 在现有任务通道上加入身份、能力、并发限制、共享队列、依赖、超时接替与审计。
- 旧 worker 密钥兼容业务读写；统一使用站点密钥，不需要模型 API。
- 每日条件、目标/行为分析、统筹草案、确认、执行反馈、复盘与后续上下文。
- 网页进度、执行者管理、自动规划设置；独立 scheduler 容器共享同一 SQLite 数据库。
- 飞书发布按能力派发，回执与副作用超时核对；不包含飞书状态自动回流。
- 新增并发进程、单执行者、多执行者、迁移、版本冲突和完整 HTTP 测试。

## 1.1.0 · 2026-10-25

- 在原账号页面增加仅任务执行密钥、复制按钮和豆包接入测试区域。
- 将模拟任务队列整合到原 Next.js 应用与 SQLite，不再使用独立执行凭据。
- 支持按客户端派发、原子领取、心跳、幂等回传、过期审查及取消。
- 数据库迁移版本 2 保留原账号、业务记录、会话及已有密钥。
- 原数据 API 拒绝执行密钥；任务控制接口仅允许登录用户访问。
- 当前仍为 simulation_only；未连接真实豆包环境、飞书或模型。

升级需备份数据库与旧镜像；数据库结构升级后，回退旧应用时应同时恢复升级前数据库。执行端暂停期间完成切换与验收。
