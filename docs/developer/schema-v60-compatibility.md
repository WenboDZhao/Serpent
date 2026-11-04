# v60 分叉库兼容

本次合流属于 L2 持久化兼容变更，设计状态为 `ready`。目标是让两条已发布分支的 v60 资源库无损升级到同一 v61，保留资产 ID、文件、人工元数据、动画关联和目录快照。公开协议与动画制作格式不变。

## 已发布历史与统一迁移链

| 输入 | v60 checksum | 升级行为 |
| --- | --- | --- |
| 动画资产 v60 | `7ffdea1d4456adb955462918c54c6a7f5ca8c157da34460c3d898328d58efa7b` | 保留 v60 记录，追加 v61 目录索引 |
| 上游目录索引 v60 | `ec395b8324fb1c87710ec597dff5915f8f669f52a815033700d15c97e444125d` | 创建动画表，将原目录迁移记录移到 v61，再登记动画 v60 |
| 未知 checksum、损坏的 v1–v59 历史或缺失的目录表 | 不接受为已知分叉 | 继续使用既有损坏诊断和恢复流程，不擅自改写历史 |

两份已发布 SQL 均保持原字节和 checksum。统一链为动画 v60、目录索引 v61；目录分叉的原 `applied_at` 和 checksum 随记录保留。v59 及更旧库继续沿正常迁移链升级，已升级库重复打开不再改写历史。

## 数据归属、事务与生命周期

`LibraryService` 是迁移历史与升级事务的唯一所有者。入口为 `openLibrary` → `migrateDatabase` → `migrateDatabaseUnserialized`；`migrateForkedLinkedDirectoryMigrationHistory` 只识别完整、精确匹配的已知 v60 历史，不放宽常规 `verifyMigrationHistory`。

v23 之后的库继续通过 SQLite `BEGIN IMMEDIATE` 串行迁移。识别在取得该锁后进行，DDL、历史行移动、动画 v60 登记和 `user_version` 更新在同一事务中完成。中断或写入失败会全部回滚，下次打开可重试；不向桌面发布半升级状态，也不引入新连接、后台任务或公共接口。

连续失败达到现有重试上限时，两种 v60 都仍可在最后成功的 schema 上写入；只读识别同样核对精确历史，不迁移、不把健康分叉误判为损坏。升级构建后的重试沿用现有 migration-failure 版本锁规则。

动画源文件和关联属于资产；标签、评分和收藏仍由原资产 ID 持有。目录快照虽可重建，本次桥接保留其 generation、条目和计数，不遍历源目录或改写资产文件。迁移成本限于建表和已有链接根的索引初始化，不新增逐资产扫描。

SQL 的维护源分别是 [动画 repository](../../src/worker/animation-assets.ts) 和 [目录索引](../../src/worker/linked-directory-index.ts) 中的常量；没有临时原型或生成代码作为唯一来源。迁移登记、校验和桥接位于 [library-service.ts](../../src/worker/library-service.ts)。未来迁移继续在 v61 后追加，禁止修改任一已发布 SQL。

## 验收与诊断

[兼容测试](../../tests/worker/schema-compatibility.test.ts) 覆盖两种 v60 的真实数据库、源与 GIF 字节、人工元数据、目录快照、重复打开、历史写入故障回滚和重试，以及未知/损坏历史的拒绝。旧 plugin-first v28 历史归一到其实际完成的 v36 后，继续执行后续迁移，避免只登记版本而遗漏新表。

- `npm run test:library-availability`：完整资源库可用性、迁移、恢复与降级链。
- `node scripts/run-vitest-with-electron.mjs run tests/worker/migration-checksum-snapshot.test.ts tests/worker/animation-assets.test.ts tests/worker/linked-directory-index.test.ts`：冻结历史 SQL，并验证两类功能仍可用。
- `npm run typecheck`、`npm run lint`：静态检查。

异常沿用 `LIBRARY_MIGRATION_FAILED` 的回滚/重试诊断；真正的历史损坏仍为 `LIBRARY_CORRUPT`。回退到不支持 v61 的旧构建时，继续遵守项目的新 schema 打开策略；不会把 v61 降写回任一种旧 v60 历史。
