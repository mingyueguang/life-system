# 人生系统 · Life Space

奶油色个人仪表盘：目标与待办、现金与还款、平台/亲友债务、睡眠/摄入/运动、订阅天数与积分。独立邮箱密码账号，不依赖 ChatGPT 登录。

## 本地运行

需要 Node.js 24.13 或更新的 24.x，使用内置 SQLite。

```sh
npm ci
cp .env.example .env.local
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

将随机值填入 `.env.local` 的 `BOOTSTRAP_TOKEN`。运行 `npm run dev`，打开 http://localhost:3000 。用初始化密钥首次注册，注册后自动关闭入口，可移除初始化密钥。邮箱仅作账号标识，不发送验证邮件。

## 部署与验证

见 [部署交接说明](./DEPLOYMENT.md) 和 [AI 接口说明](./integrations/README.md)。已提供 Dockerfile、compose.yaml、railway.json。默认单实例和 SQLite 持久磁盘，不适合原样放在无状态函数环境。

```sh
npm run typecheck
npm run build
npm test
```

测试使用临时数据库，覆盖注册关闭、来源检查、读写权限、密钥撤销、版本冲突、重启持久化、密码修改与退出会话，不创建正式账号。

## 当前范围

仅一个所有者；没有公众注册、邮件找回、MFA 或自动同步飞书。已保留稳定记录 ID、版本号、修改时间和删除标记。会员数据需手动或授权 AI 录入，未接入各平台查询余额。

演示模式不写入数据库。标记还款为已还不会自动扣减现金或债务本金。JSON 导出仅含业务记录，完整备份需备份 SQLite（`scripts/backup.mjs` 在线备份，恢复后按 `tests/backup.test.mjs` 的 12 表精确比对核对）。

版本区分：`GET /api/agent/v1/health` 返回 `app_version`（应用包版本）与 `protocol_version`（协议版本）两个字段；AI 按 `ai-guide.md` 接入时以 `protocol_version` 判断契约兼容。

本目录是独立迁移版本，原 Sites 站点及其数据未改变；没有自动迁移原站真实数据。上线前需确认旧数据迁移范围。
