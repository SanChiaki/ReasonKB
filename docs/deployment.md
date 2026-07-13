# ReasonKB 正式版部署指南

ReasonKB 正式版同时支持不限数量的本地目录、SMB 共享和致远 V8.1SP2 文档库。安装过程只配置容器运行边界、管理员账号和可选 LLM 默认值；业务数据源在启动后通过管理页配置，保存后无需重启容器。

## 1. 运行要求

- Docker Engine 和 Docker Compose v2
- 建议至少 4 核 CPU、8 GiB 内存
- SQLite、索引和转换产物所需的持久化磁盘
- 到 LLM、SMB、致远和 Gotenberg 的网络连通性
- 一个只读挂载到容器的本地数据源访问根目录

默认端口：

| 服务 | 地址 |
|---|---|
| Web | `http://localhost:43170` |
| Retrieval API | `http://localhost:43171` |
| Gotenberg | `http://localhost:43172` |

生产环境应通过防火墙或反向代理限制管理页面和内部服务端口。

## 2. 一键安装

```bash
curl -fsSL https://raw.githubusercontent.com/SanChiaki/ReasonKB/main/docker/install.sh | sh
```

默认安装目录为 `~/.reasonkb`：

```text
~/.reasonkb/
  compose.yml
  .env
  projects/              本地数据源只读访问根目录
  var/                   SQLite、索引临时数据、转换产物
  secrets/
    master.key
    admin_password
```

首次安装会输出一次管理员初始密码。之后可从宿主机的 `~/.reasonkb/secrets/admin_password` 查看；不要把它写入镜像或提交到版本库。

## 3. 密钥位置与备份

`master.key` 的权威副本在宿主机：

```text
~/.reasonkb/secrets/master.key
```

Docker 仅把它只读挂载为：

```text
/run/secrets/reasonkb_master_key
```

因此密钥不会随着容器删除而丢失。必须把 `master.key` 与 `var/app.db` 一起备份；丢失密钥后，SQLite 中已加密的 SMB 和致远凭据无法恢复。建议权限：

```bash
chmod 700 ~/.reasonkb/secrets
chmod 600 ~/.reasonkb/secrets/master.key ~/.reasonkb/secrets/admin_password
```

Web、source worker 和 index worker 在启动前会验证 master key。文件不是普通文件、内容不是 32 字节密钥，或对 group/other 开放权限时，容器会拒绝启动；不要用放宽权限的方式绕过密钥挂载问题。

恢复时应先恢复数据库和同一把 master key，再启动新容器。

## 4. 本地数据源访问边界

`.env` 中的 `REASONKB_PROJECTS_ROOT` 是宿主机路径，Compose 将其只读挂载到容器的 `/data/projects`。

```env
REASONKB_PROJECTS_ROOT=/srv/reasonkb/source-data
REASONKB_HOST_BROWSE_ROOT=/srv/reasonkb
```

管理员创建 Local 数据源时填写容器路径，例如：

```text
/data/projects
/data/projects/engineering
/data/projects/operations/manuals
```

Local source 的根路径必须位于 `/data/projects` 内。新增或编辑这个边界内的数据源立即生效；更换宿主机 bind mount 边界本身属于部署变更，需要重新创建容器。

Linux 示例：

```bash
mkdir -p /srv/reasonkb/source-data
REASONKB_PROJECTS_ROOT=/srv/reasonkb/source-data \
  sh docker/install.sh
```

macOS 可使用 OrbStack 或其他 Docker Engine，将实际目录传给 `REASONKB_PROJECTS_ROOT`。

Windows Server 使用 Docker 能直接访问的 Windows 绝对路径，并确认 Compose 所在运行时具有只读权限。不要把未验证的 WSL 路径当作 Windows Docker 主机路径。

## 5. 管理员登录

打开：

```text
http://localhost:43170/admin/login
```

使用部署管理员密码登录。所有数据源、目录选择、手工同步、停用、恢复和清除操作都要求管理员会话和 CSRF 校验。普通检索用户不能调用这些管理 API。

## 6. 添加数据源

### 6.1 Local

填写：

- 显示名称
- `/data/projects` 下的根路径
- 定时或手工同步
- 同步间隔
- 单文件大小上限

Local connector 不跟随符号链接。根目录直接文件形成 Root Collection，一级目录形成独立 Collection。

### 6.2 SMB

填写：

- host、port、share、base path
- `ntlm` 或 `negotiate`
- domain、username、password
- 同步计划和文件大小上限

SMB 不需要在容器内挂载共享，也不需要 `privileged` 或 `SYS_ADMIN`。凭据使用 master key 以 AES-256-GCM 加密保存在 SQLite 中。索引 worker 每次只下载当前 revision，处理结束后删除临时文件。

### 6.3 致远 V8.1SP2

填写：

- 致远 endpoint，例如 `http://host:port/seeyon`
- `loginName`
- REST username 和 password

连接验证成功后，逐个登记需要接入的文档库：

- 文档库显示名称
- 文档库 ID (`docLibId`)
- 根目录 ID (`rootArchiveId`)

ReasonKB 不自动枚举致远全部文档库。每个新登记默认未选中；当 source 策略为 `All` 时，登记并验证成功的新文档库会自动纳入。

致远文档同步使用：

```text
稳定身份：fr_id
版本指纹：file_id + fr_size
当前版本下载：file_id
```

`fr_create_time` 不用于判断更新。

## 7. 目录选择策略

每个 source 支持：

| 策略 | 行为 |
|---|---|
| `None` | 不选择任何 Collection，不创建可检索 Project |
| `Explicit` | 只启用明确勾选的 Collection |
| `All` | 启用当前和以后发现或登记的所有有效 Collection |

Source Collection 与 Project 一一对应。不同 source 的 Project 始终隔离，即使显示名称相同。

## 8. 热更新行为

下面操作写入 SQLite 后由 source worker 自动拾取，无需重启：

- 新建 source
- 修改显示名称、同步计划、登录身份或密码
- 登记或注销致远文档库
- `None / Explicit / All` 切换
- 手工同步
- 停用、启用、恢复和待清除

手工同步会同时请求一次 Collection 发现，因此 manual-only 的 Local/SMB source 在首次验证后也能发现目录；发现结束后不会留下周期调度时间。

Source endpoint、SMB scope 或 Local 根路径定义 source 身份边界，不能原地修改；需要创建新的 source。`loginName`、username 和 password 可在原 source 上更新。身份变化会先停止旧可见性的检索，直到验证和权威同步完成。

## 9. 数据保留

- Source 删除后默认进入 7 天 Pending Purge，可恢复。
- 立即清除需要输入 source 显示名称确认，source worker 最多约 5 秒检查一次到期清除请求。
- Missing 文档立即退出检索，旧索引保留 30 天。
- 管理审计默认保留 180 天。
- 临时下载始终在任务结束时删除；异常残留由维护任务清理。

source worker 与 index worker 都提供基于工作循环心跳的 Docker healthcheck。source worker 重启时会把遗留的 Running Sync Run/Discovery Run 标记失败、丢弃未提交观测并释放队列；index worker 会恢复遗留索引任务和运行记录。

ReasonKB 的删除只影响自身 SQLite、索引和转换产物，不会删除 Local、SMB 或致远中的源文件。

## 10. 升级迁移

升级前备份：

```bash
cp ~/.reasonkb/var/app.db ~/.reasonkb/var/app.db.backup
cp ~/.reasonkb/secrets/master.key ~/.reasonkb/secrets/master.key.backup
```

正式版迁移会：

- 保留 legacy Local/SMB 的 Project ID、document ID、索引、任务和会话引用
- 把旧 SMB secret files 导入加密 source credentials
- 删除 demo 手工上传的 Project、文档、索引、任务和托管文件
- 对多 scope 或无法识别的空 Project 停止迁移并报错

迁移成功后 SQLite 是运行时 source 配置的唯一权威数据源。

## 11. 运维命令

```bash
cd ~/.reasonkb

docker compose --env-file ./.env -f compose.yml ps
docker compose --env-file ./.env -f compose.yml logs -f web
docker compose --env-file ./.env -f compose.yml logs -f source-worker
docker compose --env-file ./.env -f compose.yml logs -f index-worker
docker compose --env-file ./.env -f compose.yml logs -f retrieval-api
```

检查配置：

```bash
docker compose --env-file ./.env -f compose.yml config --quiet
```

管理员页面展示 source 健康状态、连续失败次数、最近成功、同步历史、检索覆盖率、source item 目录和审计记录。

## 12. 完整验证

发布前至少执行：

```bash
./.venv/bin/python -m pytest -q services/tests
pnpm -C web test
pnpm -C web exec tsc --noEmit
docker compose -f docker/compose.yml config --quiet
docker compose -f docker/compose.release.yml config --quiet
```

然后重建完整 Compose，验证管理员登录、三类 source、运行时配置热生效、Office 转换、索引、检索和桌面/移动端布局。
