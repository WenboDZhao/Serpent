# 清单、脚本与计划

`scripts/catalog.py` 使用 Python 3 标准库；`scan --pixels` 可选依赖 Pillow。脚本只写显式指定的记录位置，不连接 Serpent、不导入、不修改或删除源素材。以下命令在仓库根目录执行，路径替换为本次任务路径。

## 盘点与候选排重

```sh
python3 .agents/skills/serpent-resource-import/scripts/catalog.py scan --source /absolute/originals --out /absolute/records/run-001
python3 .agents/skills/serpent-resource-import/scripts/catalog.py scan --source /absolute/originals --out /absolute/records/run-002 --hash all --pixels
python3 .agents/skills/serpent-resource-import/scripts/catalog.py duplicates --inventory /absolute/records/run-002/inventory.jsonl --previous /absolute/old/source-inventory.json --out /absolute/records/run-002/duplicate-candidates.jsonl
```

`--hash candidates` 默认只给图像和 Shader 候选计算摘要，`all` 包含普通文件，`none` 用于快速调研。审计原件是否变化或将执行导入时，应为涉及的文件取得完整 SHA-256。读取前后比较大小、mtime、ctime；扫描中变化记为错误，不能把摘要用于排重。脚本不跟随符号链接，遍历/读取错误写入清单并使退出码为非零。盘点输出不允许放在源目录内或通过符号链接进入源目录。

输出目录必须不存在，以免覆盖旧记录。`inventory.jsonl` 首行是 `header`（版本、源根、扫描选项）；后续每行一个 `file` 记录，包括相对路径、role、分类理由、大小、mtime/ctime 和可选摘要；末行 `footer` 说明扫描是否完整，缺少时不能用于最终核验。`summary.json` 保存完成状态、文件/类型/来源目录计数及错误数量。大目录按行或本地查询工具读取，不把整个清单输出到对话。

role 为 `image`、`shader`、`auxiliary`、`archive`、`excluded`、`pending`、`error`。分类是辅助判断，未知扩展名且文件头为图像的记录为 `pending`，提示在副本修复。此类文件暂记 pending；确认格式后对修复副本另行盘点与制订计划，保留它与原件摘要/路径的来源映射，不直接改写原 inventory。扫描器按明确 `.godot` 等生成目录标记缓存；其他引擎目录需 Codex 根据工程结构复核。未识别的自定义 Shader 扩展同样先待处理，不能把普通引擎资源强制改成 Shader。

`--pixels` 记录解码尺寸与帧数。只有单帧、适用的 8-bit raster 生成同画布 RGBA 指纹；完全透明像素的隐藏 RGB 归零，色彩模式与 ICC 摘要纳入指纹，不裁边、不缩放。GIF/APNG 多帧、高位深、PSD、Aseprite 和矢量源不据首帧生成静态排重指纹。解码失败有单独诊断，不把文件自动丢弃。

`duplicates` 输出本批次字节/像素候选组以及与旧清单相同摘要的来源记录；支持本脚本 JSONL、旧 `{sourceRoot, files:[{relative,sha256,...}]}` JSON。没有导入 ID 的旧清单不证明已经入库，也不自动选择较新版本。

## `plan.json` v1

```json
{
  "version": 1,
  "sourceRoot": "/absolute/originals",
  "libraryId": "target-library-id",
  "defaultFrameDurationMs": 100,
  "assets": [
    {
      "key": "pack/boar",
      "kind": "animation",
      "operation": "import",
      "name": "Boar.aseprite",
      "sources": ["Pack/Boar/Idle.png", "Pack/Boar/Walk.png"],
      "dependencies": ["Pack/Boar/Idle.meta"],
      "folder": ["Pack", "动物"],
      "tags": ["图像", "素材包/Pack", "类型/动物", "动物/野猪", "特征/动画"],
      "reason": "同一野猪主体的两个完整动作，画布与部件关系已核对"
    }
  ],
  "dispositions": [
    {"path": "Pack/Boar/Overview.png", "action": "duplicate", "assetKey": "pack/boar", "reason": "总览没有独有内容，完整帧保留在源包"},
    {"path": "Unknown/archive.zip", "action": "pending", "reason": "需先检查压缩包目录与解压预算"}
  ]
}
```

`kind`：`image` / `animation` / `shader`。`operation`：`import` / `reuse` / `update`；复用或更新必须有 `existingAssetId`。key 表示稳定的逻辑主体，不直接用可变源路径、mtime 或内容摘要作身份；内容变化通过摘要与版本单独记录。名字变动不意味着新身份。

`sources` 是已扫描图像或 Shader 的相对路径；`dependencies` 是按需使用的辅助记录。图片可以被多个切片资产引用，切片清单另行记录明确 rect。`reason` 保存判断证据；更详细的版本、切片、许可、预览配置可以另加字段或关联文件。

每个图像/Shader 候选必须进入某项资产或在 `dispositions` 中说明 `excluded`、`duplicate`、`pending`。重复项指向本计划 key 或已有资产 ID。辅助材料与范围外文件已由 inventory 的 role/reason 说明去向，不要求把数万个 JSON 再复制到计划。

```sh
python3 .agents/skills/serpent-resource-import/scripts/catalog.py validate-plan --inventory /absolute/records/run-002/inventory.jsonl --plan /absolute/records/run-002/plan.json
python3 .agents/skills/serpent-resource-import/scripts/catalog.py validate-plan --inventory /absolute/records/run-002/inventory.jsonl --plan /absolute/records/run-002/plan.json --require-complete
python3 .agents/skills/serpent-resource-import/scripts/catalog.py verify-sources --inventory /absolute/records/run-002/inventory.jsonl --plan /absolute/records/run-002/plan.json
```

`validate-plan` 检查边界、覆盖、重复 key/目标名字、标签、复用 ID 和数字结尾的静态名字，不判断动画内容是否理解正确。待处理项可以存在于有效的中间计划；`--require-complete` 要求没有待处理/遗漏/扫描错误。`verify-sources` 对计划涉及的源和依赖重新计算摘要；缺少扫描摘要、读取失败或内容变化都会失败。它不验证远端文件，远端核验通过 MCP 完成。

## 写入检查点

```sh
python3 .agents/skills/serpent-resource-import/scripts/catalog.py checkpoint --plan /absolute/records/run-002/plan.json --key pack/boar --status submitted --evidence /absolute/records/run-002/request.json --out /absolute/records/run-002/events.jsonl
```

`request.json` 只保存工具名、显式 libraryId、完整领域参数、幂等键和已准备文件摘要，不含传输头、token 或 session。其他阶段用 `prepared`、`imported`、`verified`、`failed`、`cancelled`、`cleanup-failed`、`cleaned`。检查点记录不可变证据摘要和计划摘要，便于定位同次请求；`verified` 需要逐项核验结果，`cleaned` 需要前后回读结果。每个运行日志由一个执行者顺序追加，不并发写同一文件。该命令只是记录事实，不会自动检查 MCP、重发请求、批准清理或证明任务成功。凭据字段、混用目标库或向 inventory 追加检查点会被拒绝。
