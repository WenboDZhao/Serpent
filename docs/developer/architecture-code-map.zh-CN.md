# Serpent 需求代码导航

> 按需求定位实现与测试；系统边界见[架构](architecture.md)，开发规则见[工作流](workflow.md)。核对基准：2026-11-02，`1b088f20`。更新代码后先检查相关入口是否仍适用。

## 使用方式

1. 从下表选择相关需求，读取入口及直接关联的源码、契约与测试。
2. 使用命令字符串或具名方法追踪调用；表中列的是检查范围，具体改动由需求决定。
3. 选测试前检查 fixture、环境变量与 skip 条件；本页列出测试不代表本次已执行。

源码和测试路径均相对仓库根目录。文档专题使用相对链接，可从当前笔记继续阅读。

## 需求、入口与验证

| 需求 / 现象 | 源码入口 | 关联影响 / 继续查找 | 相关测试 |
| --- | --- | --- | --- |
| 卡片外观、标题、网格密度 | `src/renderer/AssetCardMedia.tsx`、`src/renderer/asset-grid-layout.ts`、`src/renderer/styles.css` | `src/renderer/ui/tokens.css`；选择几何、布局与滚动恢复 | `tests/e2e/browsing-preferences.test.ts`、`tests/e2e/selection-marquee.test.ts` |
| 大库浏览、分页、切目录或滚动错位 | `src/renderer/use-browse-pagination.ts`、`src/renderer/browse/use-virtual-browse-session.ts` | `browse.session.*` → Worker `createBrowseSession`；generation、结果顺序、视口优先级 | `tests/worker/browse-session.test.ts`、`tests/e2e/workspace-scroll-restore.test.ts` |
| 侧栏目录、合集、工作区标签页 | `src/renderer/NavigationSidebar.tsx`、`src/renderer/WorkspaceTabs.tsx` | 同领域 Main commands / Worker handlers；物理目录、逻辑合集与智能查询的区别 | `tests/worker/folder-organize.test.ts`、`tests/e2e/workspace-tabs.test.ts` |
| 中文、英文、主题、快捷键 | `src/renderer/i18n/catalogs/zh-CN.ts`、`src/renderer/i18n/catalogs/en.ts`、`src/renderer/theme/`、`src/renderer/shortcut-runtime.ts` | 共享快捷键契约、Main 原生菜单、输入框焦点和平台差异 | `tests/e2e/custom-shortcuts.test.ts`、`tests/e2e/windows-typography.test.ts` |
| 导入、重名、重复内容、拖放 | `src/renderer/ImportDialog.tsx`、`src/main/commands/asset-ingestion.ts`、`src/worker/handlers/asset-ingestion.ts` | `prepareOrExecuteImportCancellable` / `resolveImportCancellable`；桌面来源、文件日志、派生任务与历史 | `tests/worker/import-planning.test.ts`、`tests/e2e/import-conflict-flows.test.ts` |
| 图片格式、RAW/TIFF/EXR 预览 | `src/shared/media-formats.ts`、`src/shared/preview-policy.ts` | Worker `generateThumbnail` / `getPreviewArtifact`；MIME、完整图解码、色彩、过滤与旧缓存；见[媒体格式支持](media-format-support.md) | `tests/unit/media-formats.test.ts`、`tests/e2e/raw-image-preview.test.ts`、`tests/e2e/tiff-image-preview.test.ts` |
| Aseprite 动画包、GIF 关联和 Skill 更新 | `src/shared/animation-assets.ts`、`src/worker/animation-assets.ts`、`src/worker/handlers/animation-assets.ts` | Registry `animation.*` → Worker writer lease / readonly dispatcher；迁移 v60；`reconcileOrphanArtifactFiles` 保护正式 GIF/封面；`AssetSummary.animation`、封面/悬停/GIF 查看器；项目 `.agents/skills/aseprite-animation-assets/`、`use-asset-card-hover-preview.ts` 变更缓存失效；见[动画资产](animation-assets.md) | `tests/unit/animation-assets.test.ts`、`tests/worker/animation-assets.test.ts`、`tests/skills/test_animation_assets.py`、`tests/e2e/animation-assets.test.ts` |
| 杂乱图像/Shader 整理、排重、标签和 MCP 入库 Skill | `.agents/skills/serpent-resource-import/SKILL.md`、`.agents/skills/serpent-resource-import/scripts/catalog.py` | 只读 inventory / duplicates / plan 校验 / 源摘要复核 / 检查点；复用现有动画 Skill 与当前 MCP，不新增应用接口；Unity/Godot 工程及其他媒体排除，Shader 例外 | `tests/skills/test_resource_import.py`；`python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py .agents/skills/serpent-resource-import` |
| 音频封面、波形、播放回退 | `src/shared/audio-media.ts`、`src/renderer/AudioPlayerControls.tsx`、`src/renderer/AssetPreviewModal.tsx` | `generateAudioWaveformPng` / `generateAudioProxy`；封面偏好、源/代理切换、次级任务与旧产物修复 | `tests/unit/audio-waveform-timeline.test.ts`、`tests/worker/real-common-av-formats.test.ts` |
| 视频播放、截帧、代理 | `src/renderer/VideoPlayerControls.tsx`、`src/renderer/AssetPreviewModal.tsx`、`src/worker/video-proxy-encoder.ts` | `generateVideoPoster` / `getPreviewArtifact`；Range 读取、编码器、源/代理切换 | `tests/worker/video-exr.test.ts`、`tests/e2e/media-video-playback.test.ts` |
| 3D 查看、FBX、模型缩略图 | `src/renderer/3d-viewer/`、`src/worker/fbx/`、`src/main/offscreen-thumbnail-renderer.ts` | FBX → GLB、配套贴图、Main 隐藏渲染、Worker 派生物与 AI 多视图 | `tests/worker/fbx-conversion.test.ts`、`tests/e2e/model-viewer.test.ts`、`tests/e2e/model-thumbnail.test.ts` |
| 素材盘断开、重挂载、重新关联 | `src/renderer/availability-affordance.ts`、`src/renderer/RelinkPreview.tsx`、`src/main/library-request/relink.ts` | Worker linked handler、`relinkMissingFolder` / `relinkBatchApply`；源身份、旧扫描取消、missing 状态与缓存 | `tests/worker/linked-folders.test.ts`、`tests/worker/relink-crash-recovery.test.ts` |
| NAS 打开慢、跨机器目录状态不一致 | `src/worker/network-storage.ts`、`src/worker/network-metadata-cache.ts`、`src/main/preview-cache.ts` | `openConfiguredDatabase` / `startNetworkScan`、写协调器、快照变更序号与缓存失效 | `tests/worker/network-metadata-cache.test.ts`、`tests/e2e/browse-nas-performance.test.ts`（条件执行） |
| 搜索语法、过滤、排序、漏项 | `src/renderer/search-expression.ts`、`src/worker/search-query.ts`、`src/worker/catalog-read.ts` | `searchAssets`、scope、ignore/missing 条件、FTS 与精确匹配、browse session 失效 | `tests/unit/search-expression.test.ts`、`tests/worker/search.test.ts`、`tests/worker/catalog-read.test.ts` |
| 标签、批量打标、评分、描述 | `src/renderer/TagManagementWorkspace.tsx`、`src/renderer/InspectorPanel.tsx`、`src/worker/bounded-write-command.ts` | Main tags/query commands；人工/AI 元数据、索引、事件刷新与撤回历史 | `tests/worker/organization.test.ts`、`tests/worker/bounded-write-command.test.ts`、`tests/e2e/tag-management.test.ts` |
| AI 描述/打标、语义相似检索 | `src/worker/handlers/ai.ts`、`src/main/embedding-http-index.ts`、`src/worker/semantic-index-store.ts` | AI queue、provider adapters、semantic handler、模型 profile、索引重建与切库清理 | `tests/worker/ai-analysis.test.ts`、`tests/worker/semantic-index-handler.test.ts`、`tests/e2e/semantic-sqlite-lifecycle.test.ts` |
| 插件安装、菜单、UI、Job/provider | `src/plugins/plugin-manifest.ts`、`src/main/plugin-package-manager.ts`、`src/main/plugin-activation-coordinator.ts` | `src/scripting/`、Renderer `plugin-*`、provider/job 专用桥及 Worker repository；见[插件开发](../manual/plugins/development.md)与[API](../manual/plugins/api-reference.md) | `tests/unit/plugin-activation-coordinator.test.ts`、`tests/worker/plugin-jobs.test.ts`、`tests/e2e/plugin-standard-host-activation.test.ts` |
| MCP/脚本增加命令或返回字段 | `src/automation/command-registry.ts`、`src/mcp/tool-catalog.ts`、`src/mcp/call-tool.ts` | Gateway → Worker Adapter → 只读 dispatcher / 正常写路径；输入输出、目标库、权限与幂等；见[MCP 开发](../manual/mcp/development.md)和[脚本开发](../manual/scripts/development.md) | `tests/unit/serpent-mcp-adapter.test.ts`、`tests/unit/automation-command-gateway.test.ts`、`tests/worker/automation-write-fencing.test.ts` |
| MCP 启停、端口、连接、授权 | `src/renderer/McpSettingsPage.tsx`、`src/main/embedded-mcp-server.ts`、`src/preload/bridge/mcp.ts` | 共享 MCP 契约、settings/credentials/policy stores、permission broker 与生命周期；见[MCP API](../manual/mcp/api-reference.md) | `tests/unit/embedded-mcp-server.test.ts`、`tests/unit/mcp-permission-contract.test.ts` |
| 删除、恢复、重命名、移动异常 | `src/main/commands/asset-mutations.ts`、`src/worker/handlers/asset-mutations.ts` | `file_operations`、历史、扫描围栏、语义索引清理与媒体流释放；检查磁盘与目录库 | `tests/worker/managed-move.test.ts`、`tests/worker/operation-history.integration.test.ts`、`tests/e2e/file-operation-process-recovery.test.ts` |
| 资源库打开、迁移、兼容与恢复 | `src/worker/library-service.ts`、`src/worker/lenient-columns.ts`、`src/worker/schema-failure.ts` | `openLibrary` / `MIGRATIONS`、迁移 checksum、缺列读取、备份与恢复；见[架构数据层](architecture.md#数据层) | `tests/worker/schema-compatibility.test.ts`、`tests/worker/database-recovery.test.ts`；完整跑 `npm run test:library-availability` |
| WebDAV 同步 | `src/worker/sync/`、`src/main/commands/sync.ts`、`src/main/sync-auto-scheduler.ts` | manifest、plan、runner、冲突副本；见[同步说明](../user-guide/sync.md) | `tests/worker/sync-two-device.test.ts` |
| 浏览器保存入库 | `extension/`、`src/main/extension-server.ts` | Main 接收 → Worker extension handler；来源、下载、导入与保存结果；见[浏览器扩展](../user-guide/browser-extension.md) | `tests/worker/extension-save.test.ts` |
| 启动、打包、媒体二进制缺失 | `package.json`、`forge.config.ts`、`scripts/media-binaries.mjs`、`scripts/verify-package.mjs` | native ABI、资源完整性、Vite 多入口与 E2E 构建图；见[环境搭建](setup.md)及[构建打包](build-packaging.md) | `tests/worker/real-media-bundle.test.ts`、`tests/e2e/packaged-startup.test.ts` |

## 跨层追踪

```text
组件 / hook → window.serpent → Preload bridge / transport
→ Main handleLibraryRequest / commandFor → commands/<领域>
→ LibraryWorkerClient / LibraryRequestBroker → Worker 调度与分派
→ LibraryService / repository → 结果与变化事件 → UI 刷新
```

契约从 `src/shared/library-api.ts`、`src/shared/protocol/requests.ts` 和 `src/shared/protocol/responses.ts` 查起。Main 自有设置、原生对话框等流程可能在 Main 完成。后端修改未反映到界面时，查 `src/renderer/library-change-refresh.ts` 及订阅事件。

## 容易找错的边界

- **媒体用途分开查**：卡片缩略图和完整预览使用不同路径；音频网格是 `thumbnail`，查看器波形是 `video_poster`，播放代理是 `audio_proxy`。生成算法变化时检查 `src/worker/derived-artifact-repair.ts` 与 artifact 身份。
- **磁盘场景先确认**：本地库链接外置素材盘，与整个库在外置盘/NAS 上是两类问题；缓存存在不等于完整离线能力。
- **写入查真正入口**：部分标签/评分/元数据写入由 `src/worker/bounded-write-command.ts` 执行，同名 handler 可能只报误路由错误。
- **自动化读取单独分派**：`src/main/automation-worker-adapter.ts` → `src/worker/automation-readonly-dispatch.ts` / `src/worker/automation-readonly-command-executor.ts`；新增查询核对这条路径，避免触发桌面后台写入。
- **插件按运行模式查**：`restricted` 是 QuickJS，`unrestricted` 是 Node UtilityProcess；`standard` / `trusted` 是历史别名。核心 MCP 命令与插件 MCP 导出使用不同注册入口。

## 验证与维护

运行方式见[测试](testing.md)，兼容性与提交门禁见[工作流](workflow.md)。真实媒体、NAS、硬件拔插和各平台 packaged 行为需要对应环境证据；说明实际执行结果和未测条件。

入口、协议、数据归属、事件或测试路径变更时，同步相关导航行并核对本地链接。架构及扩展规则维护在各官方专题中；本页只维护定位关系。文档内已有本地目标时使用相对链接；外部服务及当前检出缺失的内部记录保留远端链接。
