# Serpent 文档

文档分两部分：**交付文档**（对外发布，随产品分发）与**内部开发记录**（开发过程，不交付）。

## 交付文档

| 文档 | 内容 |
| --- | --- |
| [使用手册](user-guide/README.md) | 安装、导入、浏览、搜索与过滤（含实验性语义搜索）、全新 UI、标签/合集、查看器、AI 分析、插件/MCP、故障排查（中英双语） |
| [开发者文档](developer/README.md) | 本地开发、架构、测试、构建打包（中英双语；随 `main` 发布） |
| [开源贡献指南](developer/contributing.md) | 社区协作准则、Pull Request 规范与代码提交流程 |
| [扩展作者手册](manual/README.md) | 插件、脚本、MCP 开发指南与 API 参考 |
| [产品简报](product-brief.md) | 产品愿景与 MVP 边界 |
| [术语表](glossary.md) | 领域术语 |

## 内部开发记录（不交付）

开发过程文档集中在 `dolag_dev` 的 [`docs/internal/`](internal/_index.md)（不随网站发布）：架构决策（ADR）、实施规格、开发日志、QA 报告、代码审查、技术调研、开发流程与项目状态。

> 开发 agent 的入口文档见 `AGENTS.md` / `CLAUDE.md`。

## 本地阅读

文档导航使用本地相对路径。内部记录引用现可打开从 `dolag_dev` 固定提交下载的本地快照，来源、许可和范围见[快照说明](internal/_upstream-import.md)。本次未下载的次级引用、Issues、发布下载、Fork 操作和外部仓库保留在线地址。

在 Obsidian 中，以仓库根目录作为笔记库，可导航到 `CONTRIBUTORS.md` 等位于 `docs/` 外的 Markdown 文件。只以 `docs/` 作为笔记库时，可阅读该目录内的文档；[需求代码导航](developer/architecture-code-map.zh-CN.md)中的源码和测试路径相对仓库根目录，可在编辑器中查看。
