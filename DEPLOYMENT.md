# 部署交接

独立邮箱密码版人生系统；不要重新引入 ChatGPT 登录。需要 Node.js 24、一个运行实例、可写持久磁盘和 HTTPS 域名。推荐 Railway Docker + Volume 或小型 VPS；Vercel/Workers 需先替换数据库实现。

## 环境变量

- `APP_ORIGIN`：完整公开来源，例如 `https://life.example.com`，不带路径，生产必须 HTTPS。
- `BOOTSTRAP_TOKEN`：首次注册随机密钥，至少 32 字符；生成命令见 README。注册完成后移除。
- `DATABASE_PATH`：Docker 为 `/data/life.sqlite`，`/data` 必须持久化。
- `PORT`：默认 3000，可由平台设置。

秘密不要用 `NEXT_PUBLIC_` 前缀，不要提交 `.env`、数据库、备份或密钥。

## Railway

1. 导入 GitHub 仓库，指定本项目为根目录，以 Dockerfile 构建。railway.json 已提供。
2. 添加 Volume 挂载 `/data`，确认 UID/GID `1001:1001` 可以写入；平台若以 root 创建挂载目录，先调整卷权限，不要移除卷。
3. 生成 HTTPS 域名，设置环境变量，部署一个副本。
4. 网页首次注册账号，然后移除初始化密钥。重新部署不能丢失账号或重新开放注册。
5. 写入测试记录，重启确认保留；配置账单预算提醒与备份。

## VPS / Docker Compose

```sh
cp .env.example .env
# 编辑 APP_ORIGIN 为最终 HTTPS 域名，填入随机初始化密钥
docker compose up -d --build
```

服务仅绑定主机 `127.0.0.1:3000`，由同主机 Caddy/Nginx 提供 HTTPS 并反向代理。容器化代理需按实际网络调整上游。保留 named volume；`docker compose down -v` 会删除数据卷，不能用作普通更新命令。

## 备份

使用 SQLite 在线 backup API，不能只复制使用中的主数据库文件。

```sh
docker compose exec app node scripts/backup.mjs /data/backups/life-backup.sqlite
docker compose cp app:/data/backups/life-backup.sqlite ./life-backup.sqlite
```

定期把备份取出卷外，异地保存并限制访问。恢复前停服务并备份现有数据库，然后用备份替换 DATABASE_PATH 文件，清理旧库的 -wal/-shm 侧文件，文件归 UID/GID 1001:1001。启动后核对数据。迁移域名时修改 APP_ORIGIN 和 AI 客户端地址。

## 忘记密码

服务器管理员可通过标准输入运行 `scripts/reset-password.mjs`，新密码至少 12 字符。会撤销所有浏览器会话和 AI 密钥。不要把密码放命令参数。

在 Bash 中执行，密码不回显且不进入命令历史：

```bash
read -r -s -p 'New password: ' life_new_password
printf '\n'
printf '%s' "$life_new_password" | docker compose exec -T app node scripts/reset-password.mjs
unset life_new_password
```

非 Docker 用 `node --env-file=.env.local scripts/reset-password.mjs`，同样通过标准输入传密码。独立脚本不会自动加载 .env.local；备份脚本也需显式配置 DATABASE_PATH。

## 验收

运行 typecheck、build、test。确认未登录的数据接口 401，错误来源写入 403，已注册后关闭注册，HTTPS Cookie 带 Secure/HttpOnly/SameSite，只读密钥不能写、撤销密钥不可用、旧版本更新 409。确认重部署仍有数据，完成备份恢复演练。

本地构建和接口测试已通过；工作环境未安装 Docker，需接手者验证容器构建和目标平台部署。未设置定时备份、监控、邮件服务或旧站数据迁移。不要上传 node_modules、.next、data、backups、真实 .env 或数据库文件。
