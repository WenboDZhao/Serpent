# Serpent 内部文档本地快照

> 保存时间：`2026-11-02T10:34:33.174550+00:00`。上游仓库：`dolag233/Serpent`；分支：`dolag_dev`；固定提交：`2cd268085915a400c9d696313f8b2bc9e35a76ec`。

本地工作分支的产品源码没有随此次下载更新。本文档集合来自上游固定提交，包含历史设计、调研及开发记录；使用时需核对当前源码。下载的 `SKILL.md` 是供阅读的上游文档，本次没有安装或执行它。

## 下载范围

- 上一轮 38 处内部引用对应 23 个去重目标，均通过 GitHub 文件/目录接口读取成功。
- 18 个直接引用的源文件，以及目录中的上游 `README.md`，均按固定提交获取并核对 Git blob SHA。
- 5 个目录以真实清单生成本地索引；它们不是完整目录镜像，未下载条目仍链接到固定提交。QA 目录仅保存索引，没有下载其中的 QA 报告。
- 原始 38 处引用已改成本地相对链接。导入正文的相关目标已有本地副本时链接到本地；其余相对引用改为同一固定提交的在线地址，没有递归下载后续文档。
- 原文正文与原有版权信息保留；仅补充本地来源标记及调整链接。JSON 清单分别记录源内容和本地内容的校验值。

## 来源与许可

上游适用 MIT License，版权归 Serpent contributors；[完整许可证](_upstream-license.md)与本地仓库根许可证内容一致。

- [下载与链接变更清单](_upstream-import.json)
- [目录接口返回的条目清单](_upstream-directory-listings.json)
- [内部目录索引](_index.md)

## 源文件

| 本地文件 | 固定提交来源 |
| --- | --- |
| [docs/internal/README.md](README.md) | [上游原文](https://github.com/dolag233/Serpent/blob/2cd268085915a400c9d696313f8b2bc9e35a76ec/docs/internal/README.md) |
| [docs/internal/adr/0026-plugin-runtime-installation-and-trust.md](adr/0026-plugin-runtime-installation-and-trust.md) | [上游原文](https://github.com/dolag233/Serpent/blob/2cd268085915a400c9d696313f8b2bc9e35a76ec/docs/internal/adr/0026-plugin-runtime-installation-and-trust.md) |
| [docs/internal/adr/0028-schema-compatibility-read-only-degrade.md](adr/0028-schema-compatibility-read-only-degrade.md) | [上游原文](https://github.com/dolag233/Serpent/blob/2cd268085915a400c9d696313f8b2bc9e35a76ec/docs/internal/adr/0028-schema-compatibility-read-only-degrade.md) |
| [docs/internal/development-process.md](development-process.md) | [上游原文](https://github.com/dolag233/Serpent/blob/2cd268085915a400c9d696313f8b2bc9e35a76ec/docs/internal/development-process.md) |
| [docs/internal/development/2026-08-08-windows-packaging-and-squirrel-installer-development-log.md](development/2026-08-08-windows-packaging-and-squirrel-installer-development-log.md) | [上游原文](https://github.com/dolag233/Serpent/blob/2cd268085915a400c9d696313f8b2bc9e35a76ec/docs/internal/development/2026-08-08-windows-packaging-and-squirrel-installer-development-log.md) |
| [docs/internal/development/local-cicd.md](development/local-cicd.md) | [上游原文](https://github.com/dolag233/Serpent/blob/2cd268085915a400c9d696313f8b2bc9e35a76ec/docs/internal/development/local-cicd.md) |
| [docs/internal/domain-model.md](domain-model.md) | [上游原文](https://github.com/dolag233/Serpent/blob/2cd268085915a400c9d696313f8b2bc9e35a76ec/docs/internal/domain-model.md) |
| [docs/internal/implementation/0013-asset-viewer-navigation-and-gestures-vertical-slice.md](implementation/0013-asset-viewer-navigation-and-gestures-vertical-slice.md) | [上游原文](https://github.com/dolag233/Serpent/blob/2cd268085915a400c9d696313f8b2bc9e35a76ec/docs/internal/implementation/0013-asset-viewer-navigation-and-gestures-vertical-slice.md) |
| [docs/internal/implementation/0023-automation-scripting-mcp-framework.md](implementation/0023-automation-scripting-mcp-framework.md) | [上游原文](https://github.com/dolag233/Serpent/blob/2cd268085915a400c9d696313f8b2bc9e35a76ec/docs/internal/implementation/0023-automation-scripting-mcp-framework.md) |
| [docs/internal/implementation/0024-script-plugin-platform.md](implementation/0024-script-plugin-platform.md) | [上游原文](https://github.com/dolag233/Serpent/blob/2cd268085915a400c9d696313f8b2bc9e35a76ec/docs/internal/implementation/0024-script-plugin-platform.md) |
| [docs/internal/implementation/0029-ui-standardization-execution-and-plugin-ui-contract.md](implementation/0029-ui-standardization-execution-and-plugin-ui-contract.md) | [上游原文](https://github.com/dolag233/Serpent/blob/2cd268085915a400c9d696313f8b2bc9e35a76ec/docs/internal/implementation/0029-ui-standardization-execution-and-plugin-ui-contract.md) |
| [docs/internal/implementation/0031-schema-compatibility-guarantee.md](implementation/0031-schema-compatibility-guarantee.md) | [上游原文](https://github.com/dolag233/Serpent/blob/2cd268085915a400c9d696313f8b2bc9e35a76ec/docs/internal/implementation/0031-schema-compatibility-guarantee.md) |
| [docs/internal/research/asset-versioning-and-sync.md](research/asset-versioning-and-sync.md) | [上游原文](https://github.com/dolag233/Serpent/blob/2cd268085915a400c9d696313f8b2bc9e35a76ec/docs/internal/research/asset-versioning-and-sync.md) |
| [docs/internal/research/database-and-fulltext-search.md](research/database-and-fulltext-search.md) | [上游原文](https://github.com/dolag233/Serpent/blob/2cd268085915a400c9d696313f8b2bc9e35a76ec/docs/internal/research/database-and-fulltext-search.md) |
| [docs/internal/research/electron-background-worker-architecture.md](research/electron-background-worker-architecture.md) | [上游原文](https://github.com/dolag233/Serpent/blob/2cd268085915a400c9d696313f8b2bc9e35a76ec/docs/internal/research/electron-background-worker-architecture.md) |
| [docs/internal/research/media-preview-stack.md](research/media-preview-stack.md) | [上游原文](https://github.com/dolag233/Serpent/blob/2cd268085915a400c9d696313f8b2bc9e35a76ec/docs/internal/research/media-preview-stack.md) |
| [docs/internal/skills/serpent-automation/SKILL.md](skills/serpent-automation/SKILL.md) | [上游原文](https://github.com/dolag233/Serpent/blob/2cd268085915a400c9d696313f8b2bc9e35a76ec/docs/internal/skills/serpent-automation/SKILL.md) |
| [docs/internal/skills/serpent-automation/automation-api.d.ts](skills/serpent-automation/automation-api.d.ts) | [上游原文](https://github.com/dolag233/Serpent/blob/2cd268085915a400c9d696313f8b2bc9e35a76ec/docs/internal/skills/serpent-automation/automation-api.d.ts) |
| [docs/internal/ui/0006-progressive-loading-ux-principles.md](ui/0006-progressive-loading-ux-principles.md) | [上游原文](https://github.com/dolag233/Serpent/blob/2cd268085915a400c9d696313f8b2bc9e35a76ec/docs/internal/ui/0006-progressive-loading-ux-principles.md) |

## 验证边界

文件内容来自 GitHub 原始文件接口，已验证 Git blob SHA、UTF-8 格式和本地链接。在线目录清单由 GitHub API 返回，未将登录页、404 页或网页占位内容保存为正文。

Obsidian 当前没有打开 Serpent 笔记库，因此本次未实测点击导航或 Mermaid 渲染。没有打开其他笔记库、修改 Obsidian 设置、提交或推送。
