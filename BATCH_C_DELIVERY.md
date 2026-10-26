# 批次 C 交付报告 · v1.8.0（2026-10-27）

> 人生系统整改开发计划 · 第六步（补齐接口、回归测试与必要入口）及整体验收与部署准备交付。基线：批次 B `3d82c4e`（v1.7.0）。全部实现已在仓库落地并通过全量回归。

## 一、交付结论（先结论）

| 项 | 结果 |
|---|---|
| 协议版本 | 1.8.0（protocol.mjs / package.json / package-lock / schema protocolVersion / health app_version+protocol_version / ai-guide.md 六处同步） |
| 提交 | 本批次实现提交（含本报告），基于批次 B 基线 `3d82c4e`，仓库 `life-system-upgrade` 分支 `integrate-agent-execution` |
| 改动规模 | server 2 个模块 + app 3 个路由/面板 + 测试 2 个新增 + 文档 3 处（CHANGELOG / DEPLOYMENT / README / ai-guide） |
| 测试 | 28/28 全绿（备份精确比对 1 项 + 整体验收串场 1 项 + 批次 B 5 项 + 旧测试 21 项语义同步后全部通过），`next build` typecheck 通过 |
| 验收准则 | 接口当前/历史分离、正常导航设置入口、应用/协议版本区分、备份恢复精确比对、整体验收串场（登记/领取/执行/回传/恢复 + 换执行者接续 + 无过期覆盖 + 无重复待办 + 无调整原因丢失），逐项通过（见第四节） |

## 二、第六步：补齐接口、回归测试与必要入口

### 2.1 接口"当前状态 vs 历史判断"分离

- `GET /api/v1/domain-state` 返回 `{current, domains}`：
  - `current` = 服务器按**最近一次生成日**判定的最新四态（仅当前判断，客户端 KPI/面板消费）；
  - `domains` = 查询结果（含历史记录、`signals`、`pending_adjustments`，按日可查）。
- `GET /api/v1/plans` 返回 `{current, plans}`：
  - `current` = 各域 `currentPlan` 有效方案（confirmed 且未过复核期）；
  - `plans` = 全部版本历史（含 superseded / candidate / needs_review，可追溯）。

同日状态变化后：`current` 反映最新判断，历史保留在 `domains` / `plans` 中完整可查。

### 2.2 设置入口恢复（正常导航可访问）

- 新增 `GET /api/agent/v1/settings`：返回 `life_settings`，AI 与网站同源读取。
- 网站"今日方案与提醒"设置表单补齐**"异常阈值与结转"区**：三域复核周期（`domain_review_days`）、超时/精力骤降阈值与未完成结转开关（`overrun_factor` / `energy_drop_threshold` / `skip_carryover`，1.4.2 已有字段补全 UI），设置写入路径沿用既有写接口。

### 2.3 应用版本与协议版本区分

- `GET /api/agent/v1/health` 改为 `{app_version:"1.8.0", protocol_version:"1.8.0"}`：
  - `app_version` 来自应用包版本（package.json，同步 package-lock）；
  - `protocol_version` 来自 `server/protocol.mjs`；
  - 不再使用含义模糊的 `release` 字段。
- 系统面板 KPI 同步改用两字段；schema 文档与 ai-guide.md 同步（协议契约含 health 双版本、GET settings、current/domains 语义、备份恢复指引）。

### 2.4 备份恢复精确比对

- `scripts/backup.mjs`：SQLite 在线 `backup()`（不复制使用中的主库文件），关闭在线连接后以备份文件重开。
- 新增 `tests/backup.test.mjs`：对 **12 张表**（users / api_keys / executors / life_settings / records / domain_plans / plan_adjustments / daily_days / agent_jobs / publish_receipts / domain_state_log / raw_inputs）做全量 JSON 精确比对 + 恢复后服务可查断言，1/1 通过。作为备份恢复演练基准（DEPLOYMENT.md 已补充恢复后核对指引）。

## 三、整体验收串场（`tests/batch-c.test.mjs`，9 阶段自动化）

单文件串场，隔离 DB + 模拟时钟，覆盖对话第六步整体验收场景：

| 阶段 | 场景 | 断言要点 |
|---|---|---|
| 1 | 部分资料提问 | 缺 work 关键资料 → 追问具体问题（不重复问已答项） |
| 2 | 换执行者接续 / 三域具条件 | AI2（不同 key）接续完成资料；三域均具条件生成候选；确认计划+方案 v1 |
| 3 | 连续数日沿用 | 正常沿用不派发领域分析；确认后发布回执清理 |
| 4 | 改可用时间 + 执行中分析 | 调整请求制造执行中分析；改输入 → 旧结果回传被版本校验拒绝（409） |
| 5 | 单次未完成不废弃 | 单日 skipped → 次日沿用（方案不被废弃），按新预算统筹 |
| 6 | 调整请求只分析受影响域 | 仅 fitness 触发重算，work/diet 沿用；调整信号可查；成功后标记 handled（处理人=分析任务），原因不丢失 |
| 7 | 确认后发布 / 部分成功 | 只补缺失事项（unknown）不整批重做；重复确认不新建发布批次 |
| 8 | 回传丢失 / 重启 / 执行者更换 | active 恢复返回原租约；AI2 拿不到 AI1 的 running 任务；重启后任务状态保持；原执行者补交成功 |
| 9 | 无过期覆盖 / 无重复待办 | 同输入重复生成不派发重复分析、不推进版本；无 queued 堆积 |

调试过程中定位并规避的根因（已写入测试实现，非死路复现）：`claimJob` 返回已展开 request（不能二次 `JSON.parse`）；`agent_jobs` 无 `action` 列（需 `json_extract(request,'$.action')`）；`confirmPlan` 对已确认方案 409（后续日 `confirmPlans:false`、按域最新非 confirmed 版本确认）；`pendingAdjustments` 只返回 pending（handled 断言查全表）；`activeJobs` 返回 `{jobs,recovery}`。

## 四、验收准则对照（按对话第六步验收清单逐项核验）

| # | 准则 | 实现与验证 |
|---|---|---|
| 1 | AI 只读接入说明即可走通登记/领取/执行/回传/恢复 | ai-guide.md 更新（1.8.0 标题 + "版本与恢复"段：health 双版本、domain-state/plans current 语义、GET settings 读写、backup 脚本与恢复核对说明）；batch-c 阶段 2/8 以两执行者按 guide 动作走通登记→领取→执行→回传→恢复 |
| 2 | 同日状态变化后当前接口返回最新、历史保留 | batch-c 阶段 4/6 改输入与调整后，`domainState().current` 为最新判断；`domains`/`plans` 保留历史版本与信号记录 |
| 3 | 正常导航可访问必要设置 | `GET /api/agent/v1/settings` + 网站设置表单补齐"异常阈值与结转"区 |
| 4 | 测试不依赖 UUID 排序/真实日期/偶然顺序 | 隔离 DB + 注入 `t()` 假时钟；按域最新版本、`ORDER BY created DESC`、json_extract 明确查询，无真实日期/UUID 排序依赖 |
| 5 | 备份恢复后记录/版本/方案/任务/反馈准确一致 | `tests/backup.test.mjs` 12 表全量 JSON 精确比对 + 服务可查断言（1/1） |
| 6 | 整体验收场景 | batch-c 9 阶段全部断言通过（见第三节） |
| 7 | Docker/真实环境/真实飞书三项 | **待验证**：本机无 Docker 环境，未做容器构建与目标平台部署；未接入真实飞书凭据，发布链路以模拟执行者验证（见第六节） |

## 五、测试

- 新增 `tests/backup.test.mjs`：备份→关库→以备份重开→12 表精确比对（1/1）。
- 新增 `tests/batch-c.test.mjs`：整体验收 9 阶段串场（1/1）。
- 旧测试同步：integration health 版本断言由 `release` 改为 `app_version` + `protocol_version`（3 处，1.7.0→1.8.0）。
- 全量：`npm run build && npm test` → **28/28 通过**（含 typecheck）。

## 六、验证方式与缺口

- 验证方式：`node --test tests/backup.test.mjs`（1/1）、`node --test tests/batch-c.test.mjs`（1/1）、`npm run build`（typecheck 通过）、`npm test`（28/28）；集成测试需先 build（`.next` 旧构建会导致 health 版本断言读旧构建）。
- 待验证（如实说明，不冒充已做）：
  - **Docker 容器构建与目标平台部署**：本机未安装 Docker，需接手者按 DEPLOYMENT.md 在容器环境验证 `npm run build && npm test` 与启动；
  - **真实环境**：本机为本地运行验证，未做公网 HTTPS 部署与多实例验证；
  - **真实飞书发布**：发布链路（feishu.publish* / publish_receipts / 部分成功与恢复）以模拟执行者验证，未用真实飞书凭据端到端发布。
