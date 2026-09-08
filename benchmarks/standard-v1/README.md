# 标准评测集与原始语料

本目录保存冻结题集、评分依据、历史基线及来源记录；结果见 [REPORT.md](REPORT.md)。

## 原始文档下载

原始语料存放在私有仓库 [ReasonKB-Benchmark-Corpus](https://github.com/SanChiaki/ReasonKB-Benchmark-Corpus) 的 [standard-v1 Release](https://github.com/SanChiaki/ReasonKB-Benchmark-Corpus/releases/tag/standard-v1)，使用 Release 附件存储，不使用 Git LFS。

语料清单对应提交 `d62fbb1106a2baa931c3bc7ce828326a8813bcab`，对应本项目基线提交 `00dcad436e5a8ad646907426056776c9d24447f0`。

| 套件 | 原始文档 | 原始字节 | ZIP 字节 | 附件 |
|---|---:|---:|---:|---|
| natural80 | 616 | 1795727664 | 1621805753 | natural80.zip.part01 至 part08 |
| mmlongbench214 | 34 PDF | 113507445 | 105346322 | mmlongbench214.zip |

natural80 使用完整 616 文档库。mmlongbench214 有 214 道候选题，其中 210 道纳入文本评测；34 是文档数，不是题目数。

需要安装 GitHub CLI，并登录有权访问私有语料仓库的账户。以下命令应在 ReasonKB 仓库外的新目录执行，避免把原始语料提交到主项目。保留压缩包、拼接文件和解压文件时，建议至少预留 6 GB 磁盘空间。

```sh
gh auth status
gh release download standard-v1 --repo SanChiaki/ReasonKB-Benchmark-Corpus --dir corpus-standard-v1
cd corpus-standard-v1
cat natural80.zip.part01 natural80.zip.part02 natural80.zip.part03 natural80.zip.part04 natural80.zip.part05 natural80.zip.part06 natural80.zip.part07 natural80.zip.part08 > natural80.zip
shasum -a 256 -c SHA256SUMS
# 仅在全部校验通过后解压
unzip natural80.zip -d natural80
unzip mmlongbench214.zip -d mmlongbench214
```

Release 中的 `manifest.json` 保存每份原始文件的路径、大小、SHA-256 和所属套件；`SHA256SUMS` 覆盖分片和完整 ZIP。主项目各套件的 `corpus-manifest.json` 中的哈希针对提取文本，不能直接用于校验原始 PDF/Office 文件。该 Release 是本地原始文件的冻结快照，不包含历史索引数据库、运行环境或全部中间日志。

## 用于评测

1. 保留解压后的相对路径，通过 ReasonKB 目录语料导入流程接入，并等待索引完成。两套评测分别运行，natural80 应包含全部 616 份文档。
2. 先执行 `python3 scripts/standard_eval.py verify`，校验本仓库冻结题目及历史记录。
3. 用 `python3 scripts/run_standard_eval.py --help` 查看运行参数。运行器需要索引数据库快照、项目 ID 和新的输出目录；仅下载原始文件并不能直接重放历史基线。
4. 新索引的文档 ID、项目 ID 和分页可能变化，运行前核对题集与新索引的映射及参考页。记录索引、转换器、模型和代码版本；不要将不同条件下的结果当作历史基线的严格复现。

两套题分别报告；区分页面命中、证据要素覆盖及答案要素覆盖，Judge 是模型代理评分。固定语料版本不得静默覆盖；更新文件应发布新 Release 并同步本项目引用。
