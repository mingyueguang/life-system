# 部署说明 · 人生系统 v1.8.0

> 本说明给执行上传部署的 AI / 运维人员使用。包内为源码发布包（不含 `node_modules` / `.next` / `data` / `backups` / `.env*`，按 `.gitignore` 排除）。部署方式为**非 Docker 直接部署**：目标机 `npm ci` → `npm run build` → `npm start`，由 Caddy/Nginx 反向代理提供 HTTPS。

## 一、环境要求

- **Node.js 24**（`node --version` 确认，本项目依赖 `node:sqlite`）。
- 可写持久磁盘（存放 `DATABASE_PATH` 指向的 SQLite 文件与 `backups/`）。
- 一个运行实例 + HTTPS 域名（本机验证可先用 `http://localhost:3000`）。

## 二、部署步骤

```sh
# 1. 上传并解压发布包（以 v1.8.0 包为例）
unzip life-system-upgrade-v1.8.0.zip && cd life-system-upgrade-v1.8.0

# 2. 安装生产依赖（按 package-lock 精确安装）
npm ci

# 3. 配置环境变量（参照 .env.example）
cp .env.example .env.local
#    APP_ORIGIN       完整公开来源，生产必须 HTTPS，如 https://life.example.com（不带路径）
#    BOOTSTRAP_TOKEN  首次注册随机密钥，至少 32 字符，生成命令：
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
#    DATABASE_PATH    ./data/life.sqlite（保持默认即可，目录需可写）
#    PORT             默认 3000

# 4. 构建并启动（生产模式）
npm run build
npm start            # = next start，生产模式运行
```

## 三、HTTPS 反向代理（公网部署必做）

服务只监听 `127.0.0.1:PORT`（本机部署即默认）。公网部署用 Caddy / Nginx 反代：

Caddy 示例：

```caddyfile
life.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Nginx 示例：

```nginx
server {
    listen 443 ssl;
    server_name life.example.com;
    # ssl_certificate / ssl_certificate_key 配置你的证书
    location / { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto https; }
}
```

`APP_ORIGIN` 必须与最终 HTTPS 域名一致，否则 Cookie / 回调来源不匹配。

## 四、首次注册与收尾

1. 打开 `APP_ORIGIN`，用 `BOOTSTRAP_TOKEN` 完成首次注册（邮箱仅作账号标识，不发送验证邮件）。
2. 注册完成后**移除** `BOOTSTRAP_TOKEN` 并重启（注册入口自动关闭，不会重新开放注册）。
3. 写一条测试记录，重启服务确认数据保留；执行一次备份（见下）。

## 五、验收清单（部署后必跑）

| 项 | 命令 / 检查 | 期望 |
|---|---|---|
| 接口版本 | `GET /api/agent/v1/health` | `{"status":"ok","app_version":"1.8.0","protocol_version":"1.8.0"}` |
| 未登录保护 | 未带密钥请求数据接口 | 401 |
| 来源校验 | 伪造来源写入 | 403 |
| 注册关闭 | 已注册后再注册 | 关闭 |
| 方案/状态接口 | `GET /api/v1/domain-state`、`GET /api/v1/plans` | 返回 `{current,...}` 结构，current 为最新判断/有效方案 |
| 设置入口 | `GET /api/agent/v1/settings` | 返回 `life_settings`（含 domain_review_days / auto_adjust / skip_carryover） |
| 备份恢复演练 | 见下 | 12 表精确一致 |

自动化回归（可选，源码包含全部测试）：

```sh
npm test                       # 28/28 通过
node --test tests/backup.test.mjs   # 备份恢复比对 1/1
```

## 六、备份与恢复（不可省）

```sh
npm run backup                 # = node scripts/backup.mjs，默认 ./backups/life-<时间戳>.sqlite
node scripts/backup.mjs /data/backups/life-backup.sqlite   # 指定路径（备份目录需可写）
```

- 使用 SQLite 在线 `backup()`，**不要直接复制使用中的主数据库文件**。
- 定期把备份取出服务器外、异地保存并限制访问。
- 恢复：停服务 → 备份现有库 → 用备份文件替换 `DATABASE_PATH` 文件 → 清理旧库的 `-wal` / `-shm` 侧文件 → 启动 → 用 `tests/backup.test.mjs` 核对（12 张表全量 JSON 精确比对：users / api_keys / executors / life_settings / records / domain_plans / plan_adjustments / daily_days / agent_jobs / publish_receipts / domain_state_log / raw_inputs）→ 抽查 health / domain-state / plans / settings / publish-receipts → 再对外提供服务。

## 七、忘记密码（管理员）

```sh
read -r -s -p 'New password: ' life_new_password && printf '\n'
printf '%s' "$life_new_password" | node --env-file=.env.local scripts/reset-password.mjs
unset life_new_password
```

新密码至少 12 字符；执行后撤销所有浏览器会话与 AI 密钥。不要把密码放在命令参数里。

## 八、安全与运维注意事项

- 不提交、不上传 `.env*`、`data/`、`backups/`、数据库文件；`.env.local` 保持本地。
- 不要上传 `node_modules` / `.next` 到服务器以外的共享位置（包内已排除）。
- 升级部署前先备份源码、数据库与 `public/ai-guide.md`（静态说明需同步到反代静态目录，AI 客户端按 `ai-guide.md` 接入）。
- 回滚必须同时恢复数据库、源码与静态说明，不允许旧代码继续写入新库后再恢复备份。
- 版本区分：`app_version`（应用包版本）与 `protocol_version`（协议版本）分开暴露，AI 以 `protocol_version` 判断契约兼容。
