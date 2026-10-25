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
