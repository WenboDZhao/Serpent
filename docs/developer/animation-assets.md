# Aseprite 动画资产

`.aseprite` 是唯一源资产，GIF 是一对一的预览产物。库内只显示源资产的一张卡片，源 ID 持有标签、评分和收藏。卡片封面来自 GIF 的代表帧，悬停播放完整 GIF，双击进入现有 GIF 查看器；「外部打开／打开方式」解析托管源路径。

## 边界与持久化

- 项目 Skill：[aseprite-animation-assets](../../.agents/skills/aseprite-animation-assets/SKILL.md)。Codex 理解和整理 PNG/精灵图/部件，调用 Aseprite CLI 维护源文件、抽样并更新 GIF。Serpent 没有生成按钮、Aseprite 插件或外部编码器依赖。
- [共享契约](../../src/shared/animation-assets.ts)约束最多四种组合、两种动作，明确帧号、时长、层级路径及固定裁切。各格共用时间轴，配置通过规范化 JSON 的 SHA-256 判断变化。
- Gateway Registry → Worker 协议 → [动画 handler](../../src/worker/handlers/animation-assets.ts) → [Worker repository](../../src/worker/animation-assets.ts)。只有 Worker 访问文件和 SQLite；写命令持有每库 writer lease，查询走 automation-readonly dispatcher，不排媒体任务。
- 新增迁移 v60，保留既有迁移及 checksum。`animation_assets` 用 asset ID 关联最后成功 GIF、PNG 封面、配置和生成记录；`animation_requests` 保存幂等请求；`animation_preview_staging` 保存上传进度。源沿用普通托管导入和文件操作恢复，复制至 `Assets/`；GIF 和封面写入 `.serpent/artifacts/`，不会作为第二项被扫描入库。
- 预览生命周期属于资产，独立于通常按 revision 失效的缓存。源版本变化时卡片标记「预览待更新」，继续服务上次成功的 GIF/封面。重命名和托管移动不会丢失关联。已永久删除的资产不再解析预览 URL。后台孤立文件清理同时读取动画关联中的 GIF 和封面路径，不能仅依据 `revision_artifacts` 判断引用。
- 替换预览先写入并 flush 不可变文件，再在事务内切换关联、配置、生成记录和完成收据。旧文件进入 `animation_retired_files`，发布后清理；锁定的文件保留记录，下一次发布重试。源资产永久删除也会把关联文件加入该队列。

## 公开接口

详见 [MCP API](../manual/mcp/api-reference.md#动画包)。对应 Gateway command ID 为 `animation.import`、`animation.get`、`animation.read`、`animation.preview.stage`、`animation.preview.publish`、`animation.preview.cancel`。所有命令显式指定 library ID。

导入按完整参数绑定幂等键，复用正常托管导入；导入中断可留下已托管源资产，原请求记录绑定恢复目标，重试继续完成关联。不要在导入核验前删除制作目录。已完成的请求可以在本地临时文件删除后再次重试。

上传每块最多 1 MiB，不限制整个 GIF 为旧插件的 256 KiB。UUID 暂存 ID、目标资产、源 revision 和源 SHA-256 一并绑定；明确偏移，重复字节不追加，空洞及同偏移不同内容拒绝。取消清理指定暂存并可重复调用。

发布在异步解码前和事务提交前同时检查源 revision 与实际内容 SHA-256，能识别扫描尚未发现的外部修改。核验 GIF 摘要并逐帧解码后才发布封面。失败保留旧关联，暂存可恢复；源变化不能用旧配置强行覆盖。发布成功而响应丢失时，同键重试返回当前持久关联，不重复导入、不修改人工元数据。

`get` 读取源摘要、配置、生成记录及缺失状态。`read` 用预期摘要围栏分块回读源/GIF，默认 256 KiB，最大 512 KiB，避免超过 MCP 输出预算。浏览摘要采用批量窄查询，不读取大配置、不计算文件哈希、不生成预览。摘要的待更新状态按源 revision 保守判断，Skill 的是否重建判断按实际内容摘要进行。

## Skill 生命周期

Skill 依赖用户提供的 Aseprite CLI；主体 Python 仅用标准库，像素操作使用原生 Aseprite Lua。PNG 清单同时支持多文件和同一精灵图的多个矩形，源保持独立图层、位置和精确帧时长。GIF 使用最近邻缩放，并对 10ms 格式时钟做累计量化。

每次制作创建独立 `codex-animation-*` 目录及所有权标记、生成清单。只有源/GIF 分块回读校验、配置和生成记录核验通过，才删除本次目录；随后重新验证库内文件。整树清理前拒绝符号链接、越界路径、包含原始文件的目录和未经核验的运行。清理失败保留所有权和恢复状态，取消或部分导入不输出完成。

更新从库内拉取源副本；内容、配置、生成器版本均未变化且预览齐全时直接跳过。刷新只发布 GIF/配置，不修改库内源。恢复重用相同暂存 ID、偏移和发布键；成功发布后中断的恢复可识别已提交预览。

## 验证入口

- Skill 结构：`python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py .agents/skills/aseprite-animation-assets`
- PNG 精确转换及清理故障：`ASEPRITE_BIN=/absolute/aseprite python3 tests/skills/test_animation_assets.py`（独立验证器需要 Pillow；运行环境无 Aseprite 时转换测试明确 skip）。
- 接口与 Worker：`tests/unit/animation-assets.test.ts`、`tests/worker/animation-assets.test.ts`，另有 Gateway/MCP、browse、managed-move、derived-artifact 回归。
- 隔离 Electron：`node scripts/run-e2e-isolated.mjs tests/e2e/animation-assets.test.ts`。默认测试普通包；设置 `SERPENT_ANIMATION_SAMPLE_RUN`、`ASEPRITE_BIN`、`SERPENT_SKILL_PYTHON` 可消费真实 Skill 运行，覆盖 MCP 导入、回读后清理、跳过、配置更新、悬停、GIF 查看器、外部源路径和重启。设置 `SERPENT_ANIMATION_SAMPLE_LIBRARY_PARENT` 可保留正式样板库。
- 迁移完整门禁：`npm run test:library-availability`。旧库 fixture 的逆向迁移同步移除 v60 表和触发器。

首轮只做可复用功能和样板，不批量迁移资源目录。跨平台 Aseprite CLI、真实 OS 编辑器启动、NAS 和打包发行版应分别验证；Electron E2E 的 OS open 使用捕获路径的桩，以免打开用户的编辑器。macOS 隔离 runner 在仅有一块显示器时会回退至主屏，profile 和资源库仍隔离。

## 本轮实测（2026-11-02）

macOS arm64，Aseprite 1.3.18.6：Skill 验证通过；Python 5 项测试通过（同时覆盖多 PNG 和单精灵图，含两个独立部件）；接口及 Worker 回归 13 文件 / 185 项通过；库可用性与迁移回归 9 文件 / 237 项通过；`npm run typecheck` 通过。修改文件 ESLint 无错误，App/查看器保留原有 Hook 依赖警告。

隔离 Electron E2E 1 项通过，使用指定 human v1.0 原文件制作四种发型、idle/walk 两种动作的唯一 GIF：17 帧、1280ms。原文件及托管源摘要均保持 `95eca6266c76c029798e85896a1173134cadd915b3fc73170848553b25768259`。真实 MCP 验证了导入、分块回读、未变化跳过、配置变化更新、更新后悬停缓存失效、外部源路径、清理及进程重启；工作目录清理后正式关联仍可读取。额外核验四格像素各不相同且时间轴有实际帧变化。

未覆盖 Windows/Linux、NAS、发行包和真实系统编辑器启动；未批量迁移 Sunnyside_World。整个仓库的全部测试未运行，以上为本次相关测试集合。

## 试用修复（2026-11-03）

打开放置超过五分钟的样板库时，发现孤立文件清理只识别 `revision_artifacts`，会删除 `animation_assets` 持有的正式 GIF 和封面。修复将两类引用合并为同一保护集合，不改变孤立文件的清理范围和旧库降级规则。

新增回归将 GIF、封面和一个未引用文件都设为十分钟前，关闭重开并等待完整后台 reconciliation：正式动画保留，真正的孤立文件删除。旧实现可复现失败；修复后动画与 reconciliation 回归共 15 项通过。通过现有 MCP 客户端和项目 Skill 恢复了样板预览，并在真实开发版界面确认封面和 GIF 播放控制正常。源文件、资产 ID 及人工元数据保留，临时生成目录已核验后清理。
