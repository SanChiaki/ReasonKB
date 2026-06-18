# ReasonKB 部署指南

本文面向需要把 ReasonKB 跑起来的用户，覆盖 Windows Server、Windows 10/11、Linux、macOS。ReasonKB 推荐使用 release Docker Compose 部署，因为完整运行路径包含 Web 界面、检索 API、索引 Worker、目录监听器、Gotenberg Office 转 PDF 服务和 SQLite 运行数据。

本文不把 Docker Desktop 作为推荐路径。Windows Server 按 WSL Ubuntu + Docker Engine 部署。

推荐路径：

- Windows Server：WSL Ubuntu + Docker Engine，项目语料放在 Windows 磁盘目录，例如 `D:\ReasonKB\projects`。
- Windows 10/11：WSL Ubuntu + Docker Engine，项目语料可放在 Windows 磁盘目录。
- Linux：原生 Docker Engine + Docker Compose plugin。
- macOS：Colima + Docker CLI / Compose plugin。

主要访问地址：

- Web 界面：`http://localhost:43170`

本机调试地址：

- 检索 API：`http://localhost:43171`
- Gotenberg：`http://localhost:43172`

局域网或生产使用时，通常只开放 Web 端口 `43170`。

下面各系统的 TLDR 都假设 Docker 和 Docker Compose v2 已经安装好。`docker/install.sh` 会交互式引导配置项目语料目录、设置页可浏览目录、LLM API Key、Base URL、对话模型和检索模型，然后拉取 release Compose 并启动服务。也可以提前用环境变量传入这些值，脚本会直接采用。运行后仍可在设置页修改 LLM 配置，设置页保存的运行时配置优先于 `.env` 默认值。

## 一、部署原则

### 1. Windows Server 的推荐结构

Windows Server 上推荐把“程序运行状态”和“项目语料”分开：

```text
WSL Ubuntu:
  ~/.reasonkb/
    compose.yml
    .env
    var/

Windows 磁盘:
  D:\ReasonKB\projects\
    ProjectA\
      report.pdf
    ProjectB\
      handover.docx
```

这样做的好处是：

- Windows 管理员可以继续用 Windows 文件共享、备份、杀毒和权限策略管理原始项目文件。
- ReasonKB 容器通过 WSL 的 `/mnt/d/ReasonKB/projects` 路径只读挂载语料目录。
- SQLite、上传缓存、转换结果等运行数据保留在 WSL 的 `~/.reasonkb/var`，避免和原始项目文件混在一起。

Windows Server 正式部署时，建议先创建 Windows 磁盘语料目录，再安装 ReasonKB。不要沿用默认的 `~/.reasonkb/projects` 作为长期项目语料目录，除非只是临时试用。

不要把 ReasonKB 当作 Windows containers 服务部署。当前 release Compose 使用 Linux 容器镜像。

### 2. 项目语料目录规则

ReasonKB 的目录监听器会把项目语料根目录下的第一层文件夹识别为项目。

推荐：

```text
D:\ReasonKB\projects\
  ProjectA\
    report.md
    specs\scope.docx
  ProjectB\
    handover.pdf
```

不推荐：

```text
D:\ReasonKB\projects\
  report.pdf
```

也不建议直接把整个磁盘根目录（例如 `D:\`）设为项目语料根目录。请使用专用目录，例如 `D:\ReasonKB\projects`，并只把需要索引的项目文件放进去。

支持的常见文件类型包括 PDF、Markdown、文本、Word、Excel、PowerPoint 和图片。Office 文件会通过 Gotenberg 自动转换后再索引。

### 3. 部署目录和备份

一键安装脚本默认把部署文件和运行数据放在当前用户的 `~/.reasonkb` 下：

```text
~/.reasonkb/
  compose.yml
  .env
  var/
  projects/
```

其中：

- `compose.yml` 是 release 版 Docker Compose 文件。
- `.env` 保存端口、项目目录、LLM 默认配置等。
- `var/` 保存 SQLite 数据库、上传文件、Office 转换结果等运行状态。
- `projects/` 是默认项目语料目录；Windows Server 推荐改成 Windows 磁盘路径。

不建议把 `var/` 放到 Windows 磁盘挂载路径下。SQLite 和运行缓存留在 WSL/Linux 文件系统里更适合作为服务运行状态；Windows 磁盘目录只承载项目语料。

备份时至少备份：

- `~/.reasonkb/.env`
- `~/.reasonkb/var`
- 实际项目语料目录，例如 `D:\ReasonKB\projects`

## 二、Windows Server 部署

Windows Server 是本文的主路径。推荐使用 Windows Server 2022 或 Windows Server 2025，因为 Microsoft 已支持用 `wsl --install` 安装 WSL。Windows Server 2019 或更早版本限制较多，建议改用 Linux 服务器或升级系统。

### TLDR：交互式配置 LLM 和 Windows 磁盘语料目录

前提：已完成 WSL Ubuntu、systemd 和 Docker Engine 安装。然后在 Ubuntu / WSL 中执行：

```sh
mkdir -p /mnt/d/ReasonKB/projects
curl -fsSL https://raw.githubusercontent.com/SanChiaki/ReasonKB/main/docker/install.sh | \
  REASONKB_PROJECTS_ROOT=/mnt/d/ReasonKB/projects \
  REASONKB_HOST_BROWSE_ROOT=/mnt/d \
  sh
```

脚本会继续询问 LLM API Key、Base URL、对话模型和检索模型。

把项目文件放入 `D:\ReasonKB\projects\<项目名>\` 后，访问 `http://localhost:43170`。

### 1. 准备 Windows 项目语料目录

在 Windows Server 管理员 PowerShell 中执行：

```powershell
New-Item -ItemType Directory -Force D:\ReasonKB\projects | Out-Null
```

如果服务器没有 D 盘，可以换成其他数据盘。后文中的 `/mnt/d/ReasonKB/projects` 也要同步改成对应路径，例如 E 盘对应 `/mnt/e/ReasonKB/projects`。

把项目文件按第一层项目目录放进去：

```text
D:\ReasonKB\projects\
  ProjectA\
    report.pdf
    specs\scope.docx
  ProjectB\
    handover.md
```

后续在 WSL 里，这个目录对应：

```text
/mnt/d/ReasonKB/projects
```

### 2. 安装 WSL Ubuntu

在 Windows Server 管理员 PowerShell 中执行：

```powershell
wsl --install -d Ubuntu
```

按提示重启后，打开 Ubuntu，完成 Linux 用户名和密码初始化。

确认 WSL 状态：

```powershell
wsl --status
wsl -l -v
```

后续 Linux 命令都在 Ubuntu / WSL 终端中执行。

### 3. 启用 systemd

在 Ubuntu / WSL 中执行：

```sh
cat <<'EOF' | sudo tee /etc/wsl.conf
[boot]
systemd=true
EOF
```

回到 Windows Server 管理员 PowerShell：

```powershell
wsl --shutdown
```

然后重新打开 Ubuntu。

### 4. 安装 Docker Engine

在 Ubuntu / WSL 中执行：

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

关闭并重新打开 Ubuntu，让 `docker` 用户组生效。然后验证：

```sh
docker --version
docker compose version
docker info
```

### 5. 安装 ReasonKB，并直接使用 Windows 磁盘语料目录

在 Ubuntu / WSL 中执行：

```sh
mkdir -p /mnt/d/ReasonKB/projects
export REASONKB_PROJECTS_ROOT=/mnt/d/ReasonKB/projects
export REASONKB_HOST_BROWSE_ROOT=/mnt/d
curl -fsSL https://raw.githubusercontent.com/SanChiaki/ReasonKB/main/docker/install.sh | sh
```

这样安装脚本会把以下配置写入 `~/.reasonkb/.env`：

```env
REASONKB_PROJECTS_ROOT=/mnt/d/ReasonKB/projects
REASONKB_HOST_BROWSE_ROOT=/mnt/d
```

含义：

- `REASONKB_PROJECTS_ROOT` 是实际挂载进 ReasonKB 的项目语料根目录。
- `REASONKB_HOST_BROWSE_ROOT` 是设置页文件夹选择器能浏览的宿主机范围。设为 `/mnt/d` 后，设置页可以浏览 D 盘下的目录。

安装完成后，在 Windows Server 本机浏览器打开：

```text
http://localhost:43170
```

如果服务器没有图形桌面，按下一节开放 Web 端口后，从局域网内的电脑访问。

### 6. 服务器重启后恢复服务

Windows Server 重启后，先打开 Ubuntu / WSL，确认 Docker 正常，再启动 ReasonKB：

```sh
cd ~/.reasonkb
docker compose --env-file ./.env -f compose.yml up -d
```

也可以从 Windows Server PowerShell 执行：

```powershell
wsl -d Ubuntu -- bash -lc "cd ~/.reasonkb && docker compose --env-file ./.env -f compose.yml up -d"
```

如果需要无人值守启动，可以用 Windows 任务计划程序创建开机或登录任务，任务动作使用上面的 `wsl -d Ubuntu -- bash -lc ...` 命令，并以安装 ReasonKB 的 Windows 用户身份运行。

### 7. 允许局域网访问

如果只在 Windows Server 本机使用，一般访问 `http://localhost:43170` 即可。如果局域网其他机器也要访问，需要把 Windows Server 的端口转发到 WSL IP。

在 Windows Server 管理员 PowerShell 中执行：

```powershell
$WslIp = (wsl hostname -I).Trim().Split(" ")[0]
netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=43170 2>$null
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=43170 connectaddress=$WslIp connectport=43170
New-NetFirewallRule -DisplayName "ReasonKB Web 43170" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 43170
```

然后在局域网其他机器访问：

```text
http://<Windows-Server-IP>:43170
```

WSL IP 可能会在服务器重启或 `wsl --shutdown` 后变化。如果局域网访问突然失效，重新执行上面的 `portproxy` 命令。

检索 API `43171` 和 Gotenberg `43172` 通常只用于调试，不建议对外暴露。

### 8. 后续更换项目目录

如果要把语料目录从 `D:\ReasonKB\projects` 改到 `E:\ReasonKB\projects`，在 Ubuntu / WSL 中编辑：

```sh
nano ~/.reasonkb/.env
```

修改为：

```env
REASONKB_PROJECTS_ROOT=/mnt/e/ReasonKB/projects
REASONKB_HOST_BROWSE_ROOT=/mnt/e
```

然后重建容器：

```sh
cd ~/.reasonkb
docker compose --env-file ./.env -f compose.yml up -d --force-recreate --remove-orphans
```

## 三、Windows 10/11 部署

Windows 10/11 也使用 WSL Ubuntu + Docker Engine。步骤与 Windows Server 基本一致，但通常不需要 `netsh portproxy`。

### TLDR：交互式配置 LLM 和 Windows 磁盘语料目录

前提：已完成 WSL Ubuntu、systemd 和 Docker Engine 安装。然后在 Ubuntu / WSL 中执行：

```sh
mkdir -p /mnt/d/ReasonKB/projects
curl -fsSL https://raw.githubusercontent.com/SanChiaki/ReasonKB/main/docker/install.sh | \
  REASONKB_PROJECTS_ROOT=/mnt/d/ReasonKB/projects \
  REASONKB_HOST_BROWSE_ROOT=/mnt/d \
  sh
```

脚本会继续询问 LLM API Key、Base URL、对话模型和检索模型。

把项目文件放入 `D:\ReasonKB\projects\<项目名>\` 后，访问 `http://localhost:43170`。

简化流程：

1. 管理员 PowerShell 执行 `wsl --install -d Ubuntu`。
2. 打开 Ubuntu，按 Windows Server 章节启用 systemd 并安装 Docker Engine。
3. 在 Windows 磁盘创建语料目录，例如 `D:\ReasonKB\projects`。
4. 在 Ubuntu / WSL 中执行：

```sh
mkdir -p /mnt/d/ReasonKB/projects
export REASONKB_PROJECTS_ROOT=/mnt/d/ReasonKB/projects
export REASONKB_HOST_BROWSE_ROOT=/mnt/d
curl -fsSL https://raw.githubusercontent.com/SanChiaki/ReasonKB/main/docker/install.sh | sh
```

然后在 Windows 浏览器打开：

```text
http://localhost:43170
```

## 四、Linux 部署

Linux 推荐直接安装 Docker Engine 和 Docker Compose plugin。

### TLDR：交互式配置 LLM 和语料目录

前提：已完成 Docker Engine 和 Docker Compose plugin 安装。然后执行：

```sh
mkdir -p "$HOME/ReasonKB/projects"
curl -fsSL https://raw.githubusercontent.com/SanChiaki/ReasonKB/main/docker/install.sh | \
  REASONKB_PROJECTS_ROOT="$HOME/ReasonKB/projects" \
  REASONKB_HOST_BROWSE_ROOT="$HOME/ReasonKB" \
  sh
```

脚本会继续询问 LLM API Key、Base URL、对话模型和检索模型。

把项目文件放入 `~/ReasonKB/projects/<项目名>/` 后，访问 `http://localhost:43170`。

### 1. 安装 Docker Engine

Ubuntu / Debian 用户可以按 Docker 官方仓库方式安装。以 Ubuntu 为例：

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

退出当前登录会话并重新登录，然后验证：

```sh
docker --version
docker compose version
docker info
```

不要直接用 `sudo sh` 运行 ReasonKB 一键安装脚本，否则部署目录会落到 root 用户的家目录下，后续维护不方便。

### 2. 安装 ReasonKB

如果使用默认语料目录 `~/.reasonkb/projects`：

```sh
curl -fsSL https://raw.githubusercontent.com/SanChiaki/ReasonKB/main/docker/install.sh | sh
```

如果使用自定义语料目录：

```sh
mkdir -p /data/reasonkb/projects
export REASONKB_PROJECTS_ROOT=/data/reasonkb/projects
export REASONKB_HOST_BROWSE_ROOT=/data
curl -fsSL https://raw.githubusercontent.com/SanChiaki/ReasonKB/main/docker/install.sh | sh
```

打开：

```text
http://localhost:43170
```

## 五、macOS 部署

macOS 推荐使用 Colima + Docker CLI，与 Windows Server 和 Linux 的部署方式保持一致。

### TLDR：交互式配置 LLM 和语料目录

前提：已完成 Colima、Docker CLI 和 Compose plugin 安装，并已启动 Colima。然后执行：

```sh
mkdir -p "$HOME/Documents/ReasonKBProjects"
curl -fsSL https://raw.githubusercontent.com/SanChiaki/ReasonKB/main/docker/install.sh | \
  REASONKB_PROJECTS_ROOT="$HOME/Documents/ReasonKBProjects" \
  REASONKB_HOST_BROWSE_ROOT="$HOME/Documents" \
  sh
```

脚本会继续询问 LLM API Key、Base URL、对话模型和检索模型。

把项目文件放入 `~/Documents/ReasonKBProjects/<项目名>/` 后，访问 `http://localhost:43170`。

### 1. 安装 Colima、Docker CLI 和 Compose plugin

先安装 Homebrew，然后执行：

```sh
brew install colima docker docker-compose
```

如果 `docker compose version` 不可用，创建 Docker CLI plugin 软链接：

```sh
mkdir -p ~/.docker/cli-plugins
ln -sf "$(brew --prefix)/opt/docker-compose/bin/docker-compose" ~/.docker/cli-plugins/docker-compose
```

### 2. 启动 Colima

ReasonKB 当前 release Compose 默认使用 `linux/amd64` 镜像平台。Intel Mac 可以直接启动：

```sh
colima start --cpu 4 --memory 8 --disk 60
docker context use colima
```

Apple Silicon Mac 如遇到镜像平台不匹配，使用 x86_64 Colima 实例：

```sh
colima stop
colima start --arch x86_64 --cpu 4 --memory 8 --disk 60
docker context use colima
```

验证：

```sh
docker --version
docker compose version
docker info
```

### 3. 安装 ReasonKB

如果使用默认语料目录：

```sh
curl -fsSL https://raw.githubusercontent.com/SanChiaki/ReasonKB/main/docker/install.sh | sh
```

如果使用自定义语料目录：

```sh
mkdir -p /Users/you/Documents/ReasonKBProjects
export REASONKB_PROJECTS_ROOT=/Users/you/Documents/ReasonKBProjects
export REASONKB_HOST_BROWSE_ROOT=/Users/you/Documents
curl -fsSL https://raw.githubusercontent.com/SanChiaki/ReasonKB/main/docker/install.sh | sh
```

打开：

```text
http://localhost:43170
```

如果项目目录不在用户家目录下，Colima 可能需要额外配置挂载。优先把项目语料放在 `/Users/<you>/...` 下。

## 六、首次使用

### 1. 放入项目文档

把文件放到项目目录的第一层项目文件夹中，例如：

```text
D:\ReasonKB\projects\
  DemoProject\
    README.md
    proposal.docx
    report.pdf
```

目录监听器默认每 5 秒扫描一次。新文件会自动出现在 Web 界面中，并进入索引队列。

### 2. 配置 LLM

打开：

```text
http://localhost:43170/settings
```

填写：

- API Key
- Base URL
- 对话模型
- 检索模型
- 索引并发数
- 检索文档数量

运行时在设置页保存的配置会写入 SQLite，并优先于 `.env` 中的默认值。

也可以在 `~/.reasonkb/.env` 中写入默认值：

```env
PAGEINDEX_LLM_API_KEY=your_key
PAGEINDEX_LLM_BASE_URL=https://provider.example/v1
PAGEINDEX_LLM_MODEL=openai/deepseek-v4-flash
PAGEINDEX_LLM_RETRIEVAL_MODEL=openai/deepseek-v4-flash
```

修改 `.env` 后需要重建容器：

```sh
cd ~/.reasonkb
docker compose --env-file ./.env -f compose.yml up -d --force-recreate --remove-orphans
```

## 七、常用运维命令

以下命令都在部署目录执行：

```sh
cd ~/.reasonkb
```

查看服务状态：

```sh
docker compose --env-file ./.env -f compose.yml ps
```

查看日志：

```sh
docker compose --env-file ./.env -f compose.yml logs -f
```

只看某个服务：

```sh
docker compose --env-file ./.env -f compose.yml logs -f web
docker compose --env-file ./.env -f compose.yml logs -f retrieval-api
docker compose --env-file ./.env -f compose.yml logs -f index-worker
docker compose --env-file ./.env -f compose.yml logs -f directory-watcher
docker compose --env-file ./.env -f compose.yml logs -f gotenberg
```

停止服务：

```sh
docker compose --env-file ./.env -f compose.yml down
```

启动服务：

```sh
docker compose --env-file ./.env -f compose.yml up -d
```

升级到最新镜像：

```sh
docker compose --env-file ./.env -f compose.yml pull
docker compose --env-file ./.env -f compose.yml up -d --force-recreate --remove-orphans
```

备份：

```sh
docker compose --env-file ./.env -f compose.yml down
cd ~
tar -czf reasonkb-backup.tar.gz .reasonkb
cd ~/.reasonkb
docker compose --env-file ./.env -f compose.yml up -d
```

Windows Server 还要另外备份实际语料目录，例如 `D:\ReasonKB\projects`。

## 八、常见问题

### 1. 打不开 `http://localhost:43170`

先看容器状态：

```sh
cd ~/.reasonkb
docker compose --env-file ./.env -f compose.yml ps
```

再看 Web 日志：

```sh
docker compose --env-file ./.env -f compose.yml logs web
```

如果端口被占用，修改 `~/.reasonkb/.env`：

```env
WEB_PORT=43180
```

然后重建容器，访问 `http://localhost:43180`。

### 2. Windows Server 局域网访问不到

重新获取 WSL IP 并刷新端口转发：

```powershell
$WslIp = (wsl hostname -I).Trim().Split(" ")[0]
netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=43170 2>$null
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=43170 connectaddress=$WslIp connectport=43170
```

确认 Windows 防火墙允许 `43170` 入站。

### 3. 文档放进目录后没有出现

确认文件在项目文件夹下面：

```text
D:\ReasonKB\projects\
  ProjectA\
    file.pdf
```

不要直接放在语料根目录：

```text
D:\ReasonKB\projects\
  file.pdf
```

然后查看目录监听器日志：

```sh
docker compose --env-file ./.env -f compose.yml logs -f directory-watcher
```

### 4. Office 文件无法索引

确认 Gotenberg 正在运行：

```sh
docker compose --env-file ./.env -f compose.yml ps gotenberg
```

再看索引 Worker 日志：

```sh
docker compose --env-file ./.env -f compose.yml logs -f index-worker
```

### 5. 设置页不能选择目标文件夹

文件夹选择器只能浏览 `REASONKB_HOST_BROWSE_ROOT` 范围内的目录。Windows Server 推荐：

```env
REASONKB_HOST_BROWSE_ROOT=/mnt/d
```

修改后重建容器。

### 6. 镜像拉取慢或失败

ReasonKB 默认使用 Alibaba Cloud ACR 镜像：

```text
crpi-95tja6y49h58rco0.cn-shenzhen.personal.cr.aliyuncs.com/reasonkb/reasonkb:latest
crpi-95tja6y49h58rco0.cn-shenzhen.personal.cr.aliyuncs.com/reasonkb/reasonkb:gotenberg-8
```

确认网络能访问该镜像仓库后重试：

```sh
docker compose --env-file ./.env -f compose.yml pull
```

### 7. `curl: (35) SSL routines::unexpected eof while reading`

这个错误通常是当前机器访问 `raw.githubusercontent.com` 时网络、代理或 TLS 连接被中断导致的。

如果是在下载安装脚本时报错：

```sh
curl -fsSL https://raw.githubusercontent.com/SanChiaki/ReasonKB/main/docker/install.sh -o install.sh
```

可以直接重试，或改用 `wget`：

```sh
wget -O install.sh https://raw.githubusercontent.com/SanChiaki/ReasonKB/main/docker/install.sh
sh install.sh
```

如果是在运行 `./install.sh` 时下载 `compose.release.yml` 报错，安装脚本会自动重试，并在 `curl` 失败后尝试 `wget`。如果当前网络仍然无法访问 GitHub raw 文件，可以使用镜像地址：

```sh
REASONKB_COMPOSE_URL=https://your-mirror.example/compose.release.yml ./install.sh
```

也可以手动把 `docker/compose.release.yml` 下载到：

```text
~/.reasonkb/compose.yml
```

然后重新运行：

```sh
./install.sh
```

Windows Server / WSL 场景下，如果项目语料目录在 Windows D 盘，重试时仍建议保留这些配置：

```sh
REASONKB_PROJECTS_ROOT=/mnt/d/ReasonKB/projects \
REASONKB_HOST_BROWSE_ROOT=/mnt/d \
./install.sh
```

### 8. 完全卸载

先停止并删除容器：

```sh
cd ~/.reasonkb
docker compose --env-file ./.env -f compose.yml down
```

确认不再需要数据后，删除部署目录：

```sh
rm -rf ~/.reasonkb
```

Windows Server 上如果不再需要项目语料，再删除 `D:\ReasonKB\projects`。

## 九、从源码运行或开发

如果要改代码，使用本地开发模式，而不是 release 部署模式。

Python 服务：

```sh
python3 -m venv .venv
./.venv/bin/pip install --upgrade pip
./.venv/bin/pip install -r services/requirements.txt
./.venv/bin/uvicorn services.retrieval_api.app:app --reload --port 8001
```

Web 服务：

```sh
pnpm -C web install
pnpm -C web db:migrate
pnpm -C web dev
```

索引 Worker：

```sh
./.venv/bin/python -m services.index_worker.worker
```

源码开发时如需 Office 转 PDF，可以单独用 Docker 启动 Gotenberg，或使用完整 Docker Compose 做最终集成验证。

## 十、参考

- Microsoft WSL on Windows Server: https://learn.microsoft.com/en-us/windows/wsl/install-on-server
- Microsoft WSL systemd: https://learn.microsoft.com/en-us/windows/wsl/systemd
- Docker Engine on Ubuntu: https://docs.docker.com/engine/install/ubuntu/
