# Serpent MCP 导入、核验与恢复

当前 API 细节以运行中服务 `tools/list` 与返回值为准；仓库内可查 [MCP API](../../../../docs/manual/mcp/api-reference.md)、[Registry](../../../../src/automation/command-registry.ts) 和 [动画包契约](../../aseprite-animation-assets/references/package-contract.md)。这些链接用于遇到差异时定位，不要求每次读整个源码。

## 连接和准备

复用已授权的现有凭据与连接，不创建第二个 Serpent、不自行改 MCP 权限。没有连接信息时先查现有可用工具/会话，再索取缺少的信息。凭据只放当前安全连接或进程环境，不进入计划、日志、命令行、报告或 Git。共享一个 MCP 连接执行批次，避免每项建立新 session。

先读取初始化说明、`tools/list`、`serpent_library_list_open` / `serpent_library_list_recent`，确定明确的目标 `libraryId`；Desktop 当前窗口不是后续调用的默认目标。每次库级请求显式传 ID。分页读取资产、标签和文件夹；旧记录中的 ID 需要在目标库核实。

建立来源到资产的对应表，保留同内容的多个来源。复用库内目录和标签：创建前查已有对象，创建后以 ID 回读。普通可恢复操作按用户任务和现有权限继续，无需额外审批流程；服务明确拒绝时遵守返回结果，不绕过 Gateway。

## 静态图和 Shader

1. 为本次运行创建独立 staging 目录、随机所有权标记和拥有文件清单，记录 canonical 路径、源路径、摘要。记录目录在 staging 外。不要把原始文件、库内文件或其他任务放入 staging。
2. 原格式静态图和 Shader 复制到 staging，复制前后校验源摘要与副本摘要。静态文件名若以数字或 `(数字)` 结尾，在副本名末尾追加 `_static`；名称冲突增加含义前缀或稳定短摘要，保留原名记录。动画源不按此规则改动。
3. Shader 原扩展名保持不变，include/SubGraph 与纹理依赖按当前可用能力保留并记相对路径。若公开接口不能完整托管依赖，保存已核验的结果并把不完整部分明确列为待处理，不宣称“可独立使用”。
4. 保存精确 `serpent_file_import` 请求、源路径列表、`targetFolderId` 和稳定 `idempotencyKey`，再调用。按库与计划分小批，遵守实际工具大小限制。使用 `sourceKind: files`，只传精选正式副本，不把整个杂乱目录或 staging 根直接递归导入。
5. `expandImageSequences: false` 只关闭导入时自动扩展选取，不保证导入后不会分组。回读检查 `sequence`；误分组时使用当前可用的序列解散接口或 Desktop 操作，保持已有 ID，随后核实。
6. 读取完成结果的 imported/skipped/replaced 数量和实际资产。回执 `assets` 为空时，按明确目标范围与内容回读确认，不能认定未执行。重名结果不能直接选择覆盖已有资产。
7. 通过发现的标签创建/分配、元数据与目录接口完成分类。若使用 metadata 更新，先读取 `metadata.entityVersion` 再提交 `expectedVersion`，不猜测 `.version` 字段。遇到结构化错误先核对实际结果和当前 schema。

Shader 默认可能被 Serpent 识别为 `other`，无需修改 Serpent 媒体类型设置。核实是否能托管和外部打开；显示受限如实记录。未实际测试的查看能力不写“已支持”。

## 动画

读取 [动画 Skill](../../aseprite-animation-assets/SKILL.md)，用它的 inspect/prepare/import/update/resume 及包契约执行。外层计划负责完整分组、标签和跨批次身份；内层 Skill 负责像素正确性、GIF 唯一关联和 fenced 发布。不要只保存预览抽样的两种动作而丢掉源的其他动作。

动画导入后马上保存 assetId/recipe/generation 至持久记录，再完成外层标签和目录核验。动画 Skill 会在自身核验后删除其 run 目录；其终端输出和最终关联要保存在外层记录中。若内层工作目录在标签步骤之前已清理，后续失败只恢复元数据，不重做转换、重复导入。

## 远端核验

- 分页回读并定位本次真实 ID、displayName、文件夹和标签，检查唯一卡片与意外序列；复用资产也核验。
- 用实际公开的内容读取工具逐块回读并计算 SHA-256。普通内容读取若提供 revisionId，所有块必须属于同一版本，校验 byteSize、offset、进度及完整终止；读取中版本变化停止该项。当前接口无可用内容读取能力时报告未完成核验，不直接读取 Serpent 私有数据库或凭缓存假定成功。
- 动画用 `serpent_animation_get/read` 回读源和 GIF，比较源、预览、recipe 与 generation 摘要，检查 stale/previewMissing。重命名、移动后再次查询关联。
- 对新引入的组织方式实际查看代表样本；大批使用逐项内容和关联核验，界面抽样。需要重启持久性验证时先考虑用户正在编辑的状态，优先隔离库验证；未经执行不要声称“重启验证通过”。
- 执行 `verify-sources` 比对已登记的原件；最终计数区分原文件数、逻辑资产数、实际新增/复用数和标签数。

## 重试、中断和清理

超时、连接中断或返回 schema 错误不等于未执行。先读 execution/status（若当前工具提供）、库 changeSequence 和目标范围；对已支持幂等的请求，仅以原键和完全相同参数重试。不要把新的候选路径、名字或配置塞进旧键。同一错误重复且回读无新线索时保留阶段和诊断，不无限重提。动画并发源变化遵循内层 Skill 的版本围栏。

在清理前，把逐项核验、实际 ID 和摘要保存在 staging 外。完整预检清理范围：canonical 根与所有权标记匹配、无符号链接/越界成员、不包含原始目录或持久记录，且被清理产物均已托管核验或明确仅为可丢弃中间文件。只删除本次生成清单拥有的临时物；范围内出现未知文件先保留并核实。禁止直接以整个父目录执行清理。

取消或部分导入时保留必要源副本、未完成请求和恢复清单；成功项不重复导入。失败不自动删除用户库内已经成功的资产。清理失败记录剩余位置与原因。清理后再次回读正式文件/预览，才将该项标为 `cleaned`。最终报告的完成范围与证据一致。
