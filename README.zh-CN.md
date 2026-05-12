# ReasonKB

ReasonKB 是一个本地项目知识库问答服务，底层使用最新的上游 PageIndex 核心。

上游 PageIndex 源码固定放在 `vendor/pageindex`，作为独立边界维护；ReasonKB 自己的应用层代码放在 `web/`、`services/`、`docker/`，以及根目录下很薄的 `pageindex/` 兼容包中。

## 目录结构

```text
vendor/pageindex/       VectifyAI/PageIndex 最新源码快照
pageindex/              兼容导入包和 ReasonKB 环境变量桥接
services/               FastAPI 检索 API、索引 worker、目录 watcher
web/                    Next.js 项目/文档/问答界面
docker/                 容器入口脚本
fixtures/               本地项目目录挂载示例
var/                    SQLite、上传文件、转换后的证据 PDF
```

不要为了 ReasonKB 行为直接修改 `vendor/pageindex/pageindex`。运行时适配放在 `services/common/pageindex_runtime.py`，环境变量映射放在 `pageindex/env.py`，ReasonKB 默认配置放在 `services/common/pageindex_config.yaml`。

## 本地开发

安装 Python 依赖：

```bash
python3 -m venv .venv
./.venv/bin/pip install --upgrade pip
./.venv/bin/pip install -r requirements.txt
```

安装前端依赖并迁移 SQLite：

```bash
pnpm -C web install
pnpm -C web db:migrate
```

分别启动三个服务：

```bash
pnpm -C web dev
./.venv/bin/uvicorn services.retrieval_api.app:app --reload --port 8001
./.venv/bin/python -m services.index_worker.worker
```

打开 `http://localhost:3000/projects` 创建项目并上传 PDF、Markdown、文本或 Office 文件，然后在 `http://localhost:3000/chat` 提问。

## Docker

挂载项目资料目录并启动完整栈：

```bash
PROJECTS_ROOT=/absolute/path/to/projects docker compose up --build
```

默认端口：

- Web：`http://localhost:43170`
- Retrieval API：`http://localhost:43171`
- Gotenberg Office 转换服务：`http://localhost:43172`

挂载目录的一级子目录会被识别为项目：

```text
/absolute/path/to/projects/
  ProjectA/
    delivery/report.md
    office/scope.docx
  ProjectB/
    handover/report.pdf
```

## 配置

对外部署时使用 ReasonKB 自己的 LLM 环境变量，不需要暴露 `OPENAI_*`：

```bash
PAGEINDEX_LLM_API_KEY=your_key
PAGEINDEX_LLM_BASE_URL=https://provider.example/v1
```

图片证据抽取默认关闭。需要时启用：

```bash
VISION_EXTRACTION_ENABLED=true
VISION_MODEL=gpt-4.1
```

Office 文件会先通过 Gotenberg 转成证据 PDF 再索引。运行状态默认保存在 `./var`，也可以用 `APP_VAR_ROOT`、`APP_DB_PATH`、`APP_UPLOAD_ROOT`、`APP_CONVERTED_ROOT` 覆盖。

## 测试

```bash
./.venv/bin/python -m pytest services/tests -q
pnpm -C web test
pnpm -C web e2e
```

## 同步上游 PageIndex

长期维护时只刷新 vendor 快照，ReasonKB 代码保持在 vendor 外：

```bash
git fetch upstream main
rm -rf vendor/pageindex
mkdir -p vendor/pageindex
git archive upstream/main | tar -x -C vendor/pageindex
```

同步后先跑 Python 和 Web 测试，再提交。
