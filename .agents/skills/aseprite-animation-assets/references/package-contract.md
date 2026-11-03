# 包契约 v1

所有路径只存在于 Codex 本次清单或导入输入中；Serpent 查询接口不暴露库内绝对路径。`.aseprite` 被复制至托管 `Assets/`，GIF/封面存于 `.serpent/artifacts/`，配置和生成记录随数据库持久保存。

## PNG 转换清单

```json
{
  "name": "character.aseprite",
  "canvas": {"width": 32, "height": 32},
  "layers": [{"name": "body"}, {"name": "hair"}],
  "frames": [
    {"durationMs": 75, "cels": [
      {"layer": 1, "path": "/absolute/frames/body-01.png", "position": {"x": 0, "y": 0}},
      {"layer": 2, "path": "/absolute/hair-sheet.png", "rect": {"x": 0, "y": 0, "width": 32, "height": 32}, "position": {"x": 0, "y": 0}}
    ]}
  ],
  "actions": [{"name": "idle", "from": 1, "to": 1}]
}
```

`path` 必须为绝对路径。多个 PNG：每帧指定文件；精灵图：同一文件每帧指定不同 `rect`。矩形不能越界，不自动去透明边或移动基准点。缺省位置为 (0,0)。图层由下至上，`layer` 为一基索引，动作范围包含两端。分部件素材使用多个图层，不能为了预览把源文件扁平化。复杂层级可由 Codex 基于同一 Aseprite Lua API 扩展制作，再按已有源文件模式导入。

PNG 按显式清单逐文件读取单帧，不让 Aseprite 自动展开相邻编号文件；否则不同尺寸的分帧会被扩展到同一隐式画布，改变 cel 边界。源位置和尺寸必须按每张 PNG 自身验证。

## 可重建预览配置

```json
{
  "version": 1,
  "actions": [{"name": "idle", "frames": [1,2], "durationsMs": [75,75]}],
  "combinations": [{"name": "original", "layers": [[1],[2]]}],
  "crop": {"x": 0,"y": 0,"width": 32,"height": 32},
  "layout": {"columns": 1,"scale": 4,"padding": 4},
  "posterFrame": 0
}
```

动作 1–2 个，组合 1–4 个；`frames` 为源时间轴的一基索引，`durationsMs` 等长且明确。组合省略 `layers` 时使用作者原始可见性；指定时仅显示这些层级路径及其祖先。所有格共用时间轴。`crop` 是源画布上的固定矩形，不能随帧移动；缩放为最近邻整数倍。`padding` 使用源像素单位。封面为 GIF 时间轴零基帧号。源色彩超过 GIF 调色板或含半透明时，GIF 可按格式量化；`.aseprite` 必须保留原像素。

## CLI

```sh
python3 scripts/assets.py inspect --aseprite /absolute/aseprite --source /absolute/source.aseprite
python3 scripts/assets.py prepare --aseprite /absolute/aseprite --manifest /absolute/frames.json --recipe /absolute/preview.json --work-parent /absolute/scratch
python3 scripts/assets.py prepare --aseprite /absolute/aseprite --source /absolute/source.aseprite --recipe /absolute/preview.json --work-parent /absolute/scratch
python3 scripts/assets.py import --run /absolute/scratch/codex-animation-UUID --library LIBRARY_ID
python3 scripts/assets.py update --aseprite /absolute/aseprite --library LIBRARY_ID --asset ASSET_ID --work-parent /absolute/scratch
python3 scripts/assets.py resume --aseprite /absolute/aseprite --run /absolute/scratch/codex-animation-UUID
```

工作目录的 `run.json` 记录运行 ID、输入摘要、生成器版本、拥有的文件、阶段、目标资产和暂存 ID。恢复重用相同幂等键和分块偏移。导入核验成功后，源/GIF 的临时副本、拆帧、中间文件、配置、额外实验预览和调试产物都随整个本次目录删除。不要把其他任务的文件放入工作目录；原始素材必须在目录外。脚本清理前检查整棵树，不允许符号链接或越界成员。

## MCP

新增公开工具：`serpent_animation_import/get/read/preview_stage/preview_publish/preview_cancel`（实际工具全名分别为 `serpent_animation_import`、`serpent_animation_get`、`serpent_animation_read`、`serpent_animation_preview_stage`、`serpent_animation_preview_publish`、`serpent_animation_preview_cancel`）。每次调用显式传 `libraryId`。

导入使用 `{sourcePath,previewPath,sourceSha256,previewSha256,recipe,generatorVersion,idempotencyKey,targetFolderId?}`。读取使用 `{assetId,kind:"source"|"preview",expectedSha256,offsetBytes,maxBytes}`，建议 256 KiB。get 返回 recipe、generation（源摘要/版本、配置摘要、GIF 摘要、生成器版本、生成时间、尺寸）、当前源摘要以及 stale/previewMissing。

更新暂存使用 `{assetId,stagingId,expectedRevisionId,expectedSourceSha256,offsetBytes,dataBase64,complete}`；最后一块 `complete:true`。相同偏移和内容可重试，禁止空洞及覆盖不同内容。发布使用 `{assetId,stagingId,recipe,generatorVersion,previewSha256,idempotencyKey}`。取消使用 `{assetId,stagingId}`。原始输入和发布键绑定内容，不允许同键改参；冲突或源变化必须报告并保留恢复资料。

恢复更新时，只有 generation 的源摘要与源 revision、GIF 摘要、配置摘要和生成器版本均匹配本次运行，才能跳过发布。新增隐藏层或源内补充帧可能保持 GIF 字节不变，仍须发布对应新源的生成记录，避免错误保留 stale 状态。
