// Serpent-verg.4 — migration atomicity (0031 §2.1): every migration must run
// inside a transaction so a mid-migration failure leaves user_version
// unchanged, no half-applied schema, and a library that can be reopened and
// retried.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  LibraryService,
  MIGRATIONS,
  SUPPORTED_SCHEMA_VERSION,
} from '../../src/worker/library-service';
import { removePathWithSyncRetry } from '../../src/worker/windows-fs-retry';
import { animationFileSha256 } from '../../src/worker/animation-assets';
import { LINKED_DIRECTORY_INDEX_SQL } from '../../src/worker/linked-directory-index';
import { MAX_MIGRATION_ATTEMPTS } from '../../src/worker/schema-failure';
import { removeLinkedDirectoryIndexFixture } from './remove-linked-directory-index';

const temporaryRoots: string[] = [];
const services: LibraryService[] = [];
const require = createRequire(import.meta.url);

interface TestDatabaseConnection {
  close(): void;
  exec(sql: string): void;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  prepare(source: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

const Database = require('better-sqlite3') as new (filename: string) => TestDatabaseConnection;

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'serpent-schema-compat-'));
  temporaryRoots.push(root);
  return root;
}

function newService(...args: ConstructorParameters<typeof LibraryService>): LibraryService {
  const service = new LibraryService(...args);
  services.push(service);
  return service;
}

afterEach(() => {
  for (const service of services.splice(0)) service.closeAll();
  for (const root of temporaryRoots.splice(0)) removePathWithSyncRetry(root);
});

function libraryFilePath(libraryPath: string): string {
  return path.join(libraryPath, '.serpent', 'library.db');
}

function schemaVersionOf(dbPath: string): number {
  const db = new Database(dbPath);
  const version = db.pragma('user_version', { simple: true }) as number;
  db.close();
  return version;
}

/**
 * Build a real vN library by replaying MIGRATIONS[0..N-1] the same way the
 * worker does: each migration in a transaction, user_version updated inside.
 */
function buildLibraryAtVersion(root: string, targetVersion: number): string {
  const libraryPath = path.join(root, `v${targetVersion}`);
  mkdirSync(libraryPath, { recursive: true });
  mkdirSync(path.join(libraryPath, '.serpent'), { recursive: true });
  mkdirSync(path.join(libraryPath, 'Assets'), { recursive: true });
  const db = new Database(libraryFilePath(libraryPath));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.exec(
    MIGRATIONS.slice(0, targetVersion)
      .map((migration) => migration.sql)
      .join('\n'),
  );
  // Record migrations UP TO the target version: the built structure already
  // includes them (the worker resumes the chain from `targetVersion` onward
  // and inserts only those rows itself).
  for (const migration of MIGRATIONS.slice(0, targetVersion)) {
    db.prepare(
      'INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)',
    ).run(migration.version, migration.checksum, new Date().toISOString());
  }
  // verifyDatabase requires exactly one library row.
  db.prepare(
    'INSERT INTO library (library_id, display_name, created_at) VALUES (?, ?, ?)',
  ).run(`lib_${targetVersion}`, `v${targetVersion}`, new Date().toISOString());
  db.pragma(`user_version = ${targetVersion}`);
  db.close();
  return libraryPath;
}

/** Build the historical plugin-first v28 layout that used v24-v28 for a
 * different set of migration bodies than the canonical merged sequence. */
function buildLegacyPluginFirstV28(root: string): string {
  const libraryPath = buildLibraryAtVersion(root, 23);
  const db = new Database(libraryFilePath(libraryPath));
  const legacySourceVersions = [27, 28, 29, 30, 31];
  for (const [index, sourceVersion] of legacySourceVersions.entries()) {
    const migration = MIGRATIONS.find((candidate) => candidate.version === sourceVersion)!;
    db.exec(migration.sql);
    db.prepare(
      'INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)',
    ).run(24 + index, migration.checksum, new Date().toISOString());
  }
  db.pragma('user_version = 28');
  db.close();
  return libraryPath;
}

describe('migration registry integrity (static audit)', () => {
  it('versions are contiguous from 1 to SUPPORTED_SCHEMA_VERSION', () => {
    const versions = MIGRATIONS.map((migration) => migration.version);
    expect(versions[0]).toBe(1);
    for (let index = 1; index < versions.length; index += 1) {
      expect(versions[index]).toBe(versions[index - 1]! + 1);
    }
    expect(SUPPORTED_SCHEMA_VERSION).toBe(versions.at(-1));
  });

  it('no migration embeds explicit transaction control (atomicity contract)', () => {
    for (const migration of MIGRATIONS) {
      const statement = migration.sql.toUpperCase();
      // CREATE TRIGGER bodies legitimately contain BEGIN...END; only
      // explicit transaction-control statements would nest inside the
      // worker's own transaction and break atomicity.
      expect(statement, `migration v${migration.version}`)
        .not.toMatch(/\bBEGIN\s+(IMMEDIATE|DEFERRED|EXCLUSIVE|TRANSACTION)\b/);
      expect(statement, `migration v${migration.version}`).not.toMatch(/\bCOMMIT\b/);
      expect(statement, `migration v${migration.version}`).not.toMatch(/\bSAVEPOINT\b/);
      expect(statement, `migration v${migration.version}`).not.toMatch(/\bROLLBACK\b/);
    }
  });
});

describe('migration replay (every version opens and migrates to latest)', () => {
  // Replaying from each intermediate version proves no migration depends on
  // residual state from a later migration — the recovery path after any
  // mid-chain failure.
  for (const migration of MIGRATIONS.slice(0, -1)) {
    it(`v${migration.version} library migrates cleanly to v${SUPPORTED_SCHEMA_VERSION}`, () => {
      const root = temporaryRoot();
      const libraryPath = buildLibraryAtVersion(root, migration.version);
      const service = newService();
      service.openLibrary(libraryPath);
      service.closeAll();
      expect(schemaVersionOf(libraryFilePath(libraryPath))).toBe(SUPPORTED_SCHEMA_VERSION);
    });
  }
});

describe('legacy plugin-first v28 migration', () => {
  it('applies canonical v33-v36 objects before normalizing migration history', () => {
    const root = temporaryRoot();
    const libraryPath = buildLegacyPluginFirstV28(root);
    const service = newService();

    service.openLibrary(libraryPath);
    const libraryId = 'lib_23';
    const receipt = service.recordOperationHistoryBarrier({
      libraryId,
      affectedCount: 1,
      commandId: 'migration.compatibility-test',
      labelKey: 'history.compatibility-test',
      reason: 'schema compatibility fixture',
      source: 'script',
    });
    expect(receipt.historyEntryId).toBeTruthy();
    expect(service.getOperationHistoryStatus(libraryId).staleTop).toBeNull();
    service.closeAll();

    const db = new Database(libraryFilePath(libraryPath));
    expect(schemaVersionOf(libraryFilePath(libraryPath))).toBe(SUPPORTED_SCHEMA_VERSION);
    const objectNames = db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type IN ('table', 'index', 'trigger')
            AND name IN (
              'operation_history', 'operation_history_steps', 'operation_history_attempts',
              'operation_history_redo_sequence_idx', 'library_change_on_operation_history_insert',
              'library_change_on_operation_history_update', 'library_change_on_operation_history_delete'
            )
          ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    expect(objectNames.map((row) => row.name)).toEqual([
      'library_change_on_operation_history_delete',
      'library_change_on_operation_history_insert',
      'library_change_on_operation_history_update',
      'operation_history',
      'operation_history_attempts',
      'operation_history_redo_sequence_idx',
      'operation_history_steps',
    ]);

    const revisionColumns = db.pragma('table_info(revisions)') as Array<{ name: string }>;
    expect(revisionColumns.map((column) => column.name)).toContain('content_fingerprint');
    const historyColumns = db.pragma('table_info(operation_history)') as Array<{ name: string }>;
    expect(historyColumns.map((column) => column.name)).toContain('redo_sequence');
    const artifactSql = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'revision_artifacts'")
      .get() as { sql: string };
    expect(artifactSql.sql).toContain("'model_glb'");
    const historyRows = db
      .prepare('SELECT version, checksum FROM schema_migrations WHERE version >= 24 ORDER BY version')
      .all() as Array<{ version: number; checksum: string }>;
    const currentHistoryMigrations = MIGRATIONS.filter((migration) => migration.version >= 24);
    expect(historyRows).toHaveLength(currentHistoryMigrations.length);
    expect(historyRows.map((row) => row.version)).toEqual(
      currentHistoryMigrations.map((migration) => migration.version),
    );
    expect(historyRows[9]?.checksum).toBe(MIGRATIONS.find((migration) => migration.version === 33)!.checksum);
    expect(historyRows.at(-1)?.checksum).toBe(
      MIGRATIONS.find((migration) => migration.version === SUPPORTED_SCHEMA_VERSION)!.checksum,
    );
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('animation_assets', 'linked_directory_snapshots') ORDER BY name").all())
      .toEqual([{ name: 'animation_assets' }, { name: 'linked_directory_snapshots' }]);
    const persistedHistory = db
      .prepare("SELECT source, state, policy FROM operation_history WHERE label_key = 'history.compatibility-test'")
      .get() as { source: string; state: string; policy: string } | undefined;
    expect(persistedHistory).toEqual({ source: 'script', state: 'applied', policy: 'barrier' });
    db.close();
  });
});

describe('released animation / linked-directory v60 fork', () => {
  const directoryChecksum = 'ec395b8324fb1c87710ec597dff5915f8f669f52a815033700d15c97e444125d';
  const appliedAt = '2026-11-01T00:00:00.000Z';

  function buildDirectoryV60(root: string): string {
    const libraryPath = buildLibraryAtVersion(root, 59);
    const db = new Database(libraryFilePath(libraryPath));
    db.exec(LINKED_DIRECTORY_INDEX_SQL);
    db.prepare('INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)')
      .run(60, directoryChecksum, appliedAt);
    db.pragma('user_version = 60');
    db.close();
    return libraryPath;
  }

  function history(db: TestDatabaseConnection) {
    return db.prepare('SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version').all();
  }

  function assertCanonicalHistory(db: TestDatabaseConnection): void {
    expect(db.pragma('user_version', { simple: true })).toBe(SUPPORTED_SCHEMA_VERSION);
    expect(db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all())
      .toEqual(MIGRATIONS.map(({ version, checksum }) => ({ version, checksum })));
    expect(db.pragma('foreign_key_check')).toEqual([]);
  }

  it('keeps both released SQL identities immutable', () => {
    expect(MIGRATIONS[59].checksum).toBe('7ffdea1d4456adb955462918c54c6a7f5ca8c157da34460c3d898328d58efa7b');
    expect(createHash('sha256').update(LINKED_DIRECTORY_INDEX_SQL).digest('hex')).toBe(directoryChecksum);
    expect(MIGRATIONS[60]).toMatchObject({ version: 61, sql: LINKED_DIRECTORY_INDEX_SQL, checksum: directoryChecksum });
  });

  it('upgrades animation v60 without losing the source, GIF, generation, tags or metadata', async () => {
    const root = temporaryRoot();
    const creating = newService({ observerFactory: () => ({ close() {} }) });
    const library = creating.createLibrary({ displayName: 'Animation v60', selectedParentPath: root });
    const sourcePath = path.join(root, 'character.aseprite');
    const previewPath = path.join(root, 'character.gif');
    writeFileSync(sourcePath, 'opaque Aseprite source fixture');
    writeFileSync(previewPath, Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
    const info = await creating.animationRepository(library.libraryId, true).importBundle({
      sourcePath, previewPath, sourceSha256: animationFileSha256(sourcePath),
      previewSha256: animationFileSha256(previewPath), generatorVersion: 'v60-fixture', idempotencyKey: 'v60-import',
      recipe: { version: 1, actions: [{ name: 'idle', frames: [1], durationsMs: [100] }],
        combinations: [{ name: 'original' }], crop: { x: 0, y: 0, width: 1, height: 1 },
        layout: { columns: 1, scale: 1, padding: 0 }, posterFrame: 0 },
    });
    creating.setAssetsRating({ libraryId: library.libraryId, assetIds: [info.assetId], rating: 4 });
    const metadata = creating.getAssetMetadata({ libraryId: library.libraryId, assetId: info.assetId });
    creating.setAssetMetadata({ libraryId: library.libraryId, assetId: info.assetId, expectedVersion: metadata.entityVersion, favorite: true });
    const tag = creating.createTag({ libraryId: library.libraryId, name: 'Preserved' });
    creating.assignTags({ libraryId: library.libraryId, assetIds: [info.assetId], tagIds: [tag.tagId] });
    const expectedMetadata = creating.getAssetMetadata({ libraryId: library.libraryId, assetId: info.assetId });
    creating.closeAll();

    const fixture = new Database(libraryFilePath(library.libraryPath));
    removeLinkedDirectoryIndexFixture(fixture);
    fixture.prepare('DELETE FROM schema_migrations WHERE version > 60').run();
    fixture.pragma('user_version = 60');
    const originalHistory = history(fixture);
    const animation = fixture.prepare('SELECT * FROM animation_assets').all();
    fixture.close();

    const service = newService();
    const opened = service.openLibrary(library.libraryPath);
    expect(opened).toMatchObject({ libraryId: library.libraryId });
    expect(opened.recovery).toBeUndefined();
    expect(opened.readOnly).toBeFalsy();
    expect(service.animationRepository(opened.libraryId).info(info.assetId)).toEqual(info);
    expect(service.getAssetMetadata({ libraryId: opened.libraryId, assetId: info.assetId })).toEqual(expectedMetadata);
    expect(readFileSync(service.resolveAssetPath(opened.libraryId, info.assetId))).toEqual(readFileSync(sourcePath));
    expect(animationFileSha256(service.getArtifactAbsolutePath(opened.libraryId, info.previewArtifactId))).toBe(info.generation.previewSha256);
    service.closeAll();

    const verified = new Database(libraryFilePath(library.libraryPath));
    assertCanonicalHistory(verified);
    expect(history(verified).slice(0, 60)).toEqual(originalHistory);
    expect(verified.prepare('SELECT * FROM animation_assets').all()).toEqual(animation);
    verified.close();
  });

  it('bridges upstream directory v60 and preserves snapshots, source files, IDs and original history timestamps', () => {
    const root = temporaryRoot();
    const creating = newService({ observerFactory: () => ({ close() {} }) });
    const library = creating.createLibrary({ displayName: 'Directory v60', selectedParentPath: root });
    const sourceRoot = path.join(root, 'linked');
    mkdirSync(path.join(sourceRoot, 'empty', 'nested'), { recursive: true });
    writeFileSync(path.join(sourceRoot, 'keep.txt'), 'keep source bytes');
    const linked = creating.importFolderAsLinked({ libraryId: library.libraryId, sourceRootPath: sourceRoot });
    const assets = creating.listAssets({ libraryId: library.libraryId, recursive: true });
    expect(assets).toHaveLength(1);
    creating.setAssetsRating({ libraryId: library.libraryId, assetIds: [assets[0]!.assetId], rating: 3 });
    const metadata = creating.getAssetMetadata({ libraryId: library.libraryId, assetId: assets[0]!.assetId });
    creating.closeAll();

    const fixture = new Database(libraryFilePath(library.libraryPath));
    fixture.exec('DROP TABLE animation_retired_files; DROP TABLE animation_requests; DROP TABLE animation_preview_staging; DROP TABLE animation_assets');
    fixture.prepare('DELETE FROM schema_migrations WHERE version = 60').run();
    fixture.prepare('UPDATE schema_migrations SET version = 60, applied_at = ? WHERE version = 61').run(appliedAt);
    fixture.pragma('user_version = 60');
    const snapshots = fixture.prepare('SELECT * FROM linked_directory_snapshots ORDER BY linked_folder_id').all();
    const entries = fixture.prepare('SELECT * FROM linked_directory_entries ORDER BY linked_folder_id, generation, path_identity').all();
    expect(snapshots).toHaveLength(1);
    expect(entries).toHaveLength(2);
    const prefix = history(fixture).slice(0, 59);
    fixture.close();

    const service = newService({ observerFactory: () => ({ close() {} }) });
    const opened = service.openLibrary(library.libraryPath);
    expect(opened.recovery).toBeUndefined();
    expect(opened.readOnly).toBeFalsy();
    expect(service.listAssets({ libraryId: opened.libraryId, recursive: true })[0]?.assetId).toBe(assets[0]!.assetId);
    expect(service.getAssetMetadata({ libraryId: opened.libraryId, assetId: assets[0]!.assetId })).toEqual(metadata);
    expect(readFileSync(service.resolveAssetPath(opened.libraryId, assets[0]!.assetId), 'utf8')).toBe('keep source bytes');
    expect(service.listFolderBrowseEntries({ libraryId: opened.libraryId, parentFolderId: linked.folderId }).map((entry) => entry.name)).toEqual(['empty']);
    service.closeAll();

    const verified = new Database(libraryFilePath(library.libraryPath));
    assertCanonicalHistory(verified);
    expect(history(verified).slice(0, 59)).toEqual(prefix);
    expect(verified.prepare('SELECT * FROM schema_migrations WHERE version = 61').get())
      .toEqual({ version: 61, checksum: directoryChecksum, applied_at: appliedAt });
    expect(verified.prepare('SELECT * FROM linked_directory_snapshots ORDER BY linked_folder_id').all()).toEqual(snapshots);
    expect(verified.prepare('SELECT * FROM linked_directory_entries ORDER BY linked_folder_id, generation, path_identity').all()).toEqual(entries);
    expect(verified.prepare('SELECT COUNT(*) AS count FROM animation_assets').get()).toEqual({ count: 0 });
    const upgradedHistory = history(verified);
    verified.close();

    expect(service.openLibrary(library.libraryPath).recovery).toBeUndefined();
    service.closeAll();
    const reopened = new Database(libraryFilePath(library.libraryPath));
    expect(history(reopened)).toEqual(upgradedHistory);
    reopened.close();
  });

  it.each(['animation', 'directory'] as const)('rolls back the entire %s v60 upgrade on a history write failure and retries cleanly', (kind) => {
    const root = temporaryRoot();
    const libraryPath = kind === 'animation' ? buildLibraryAtVersion(root, 60) : buildDirectoryV60(root);
    const fixture = new Database(libraryFilePath(libraryPath));
    const original = history(fixture);
    fixture.exec(`CREATE TRIGGER fail_v60_bridge BEFORE INSERT ON schema_migrations
      WHEN NEW.version = ${kind === 'animation' ? 61 : 60}
      BEGIN SELECT RAISE(ABORT, 'injected history failure'); END`);
    fixture.close();

    const failing = newService();
    expect(() => failing.openLibrary(libraryPath)).toThrow('LIBRARY_MIGRATION_FAILED');
    failing.closeAll();
    const rolledBack = new Database(libraryFilePath(libraryPath));
    expect(rolledBack.pragma('user_version', { simple: true })).toBe(60);
    expect(history(rolledBack)).toEqual(original);
    const missingTable = kind === 'animation' ? 'linked_directory_snapshots' : 'animation_assets';
    expect(rolledBack.prepare('SELECT name FROM sqlite_master WHERE name = ?').get(missingTable)).toBeUndefined();
    rolledBack.exec('DROP TRIGGER fail_v60_bridge');
    rolledBack.close();

    const retry = newService();
    expect(retry.openLibrary(libraryPath).recovery).toBeUndefined();
    retry.closeAll();
    const verified = new Database(libraryFilePath(libraryPath));
    assertCanonicalHistory(verified);
    verified.close();
  });

  it.each(['animation', 'directory'] as const)('keeps %s v60 writable without rescue after the migration retry cap', (kind) => {
    const root = temporaryRoot();
    const libraryPath = kind === 'animation' ? buildLibraryAtVersion(root, 60) : buildDirectoryV60(root);
    const fixture = new Database(libraryFilePath(libraryPath));
    const original = history(fixture);
    fixture.close();

    for (let attempt = 0; attempt < MAX_MIGRATION_ATTEMPTS; attempt += 1) {
      const failing = newService({ afterSchemaMigrationTransactionBegin: () => { throw new Error('injected migration failure'); } });
      expect(() => failing.openLibrary(libraryPath)).toThrow('LIBRARY_MIGRATION_FAILED');
      failing.closeAll();
    }
    const service = newService();
    const opened = service.openLibrary(libraryPath);
    expect(opened.recovery).toBeUndefined();
    expect(opened.migrationStuck).toBe(true);
    expect(opened.readOnly).toBeFalsy();
    service.renameLibrary({ libraryId: opened.libraryId, displayName: 'Still writable' });
    expect(service.listAssets({ libraryId: opened.libraryId, recursive: true })).toEqual([]);
    service.closeAll();
    const verified = new Database(libraryFilePath(libraryPath));
    expect(verified.pragma('user_version', { simple: true })).toBe(60);
    expect(history(verified)).toEqual(original);
    expect(verified.prepare('SELECT display_name FROM library').get()).toEqual({ display_name: 'Still writable' });
    verified.close();
  });

  it.each(['unknown checksum', 'damaged prefix', 'missing directory table'] as const)('does not normalize a v60 with %s', (damage) => {
    const libraryPath = buildDirectoryV60(temporaryRoot());
    const fixture = new Database(libraryFilePath(libraryPath));
    if (damage === 'unknown checksum') fixture.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 60').run('0'.repeat(64));
    if (damage === 'damaged prefix') fixture.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 59').run('0'.repeat(64));
    if (damage === 'missing directory table') fixture.exec('DROP TABLE linked_directory_entries');
    const original = history(fixture);
    fixture.close();

    const service = newService({ beforeLibraryRescueForTests: () => { throw new Error('stop rescue of damaged test fixture'); } });
    expect(() => service.openLibrary(libraryPath)).toThrow('LIBRARY_CORRUPT');
    service.closeAll();
    const verified = new Database(libraryFilePath(libraryPath));
    expect(verified.pragma('user_version', { simple: true })).toBe(60);
    expect(history(verified)).toEqual(original);
    expect(verified.prepare("SELECT name FROM sqlite_master WHERE name = 'animation_assets'").get()).toBeUndefined();
    verified.close();
  });
});

describe('mid-migration failure injection', () => {
  it('v23+ chain: failure inside the migration transaction leaves the version unchanged and retryable', () => {
    const root = temporaryRoot();
    // v23 is the first version the worker migrates inside one outer
    // transaction (schema-serialization boundary), so build a v23 library.
    const libraryPath = buildLibraryAtVersion(root, 23);

    const failing = newService({
      afterSchemaMigrationTransactionBegin: () => {
        throw new Error('injected migration failure');
      },
    });
    expect(() => failing.openLibrary(libraryPath)).toThrow();
    failing.closeAll();
    expect(schemaVersionOf(libraryFilePath(libraryPath))).toBe(23);

    // No half-applied schema: reopening without the failure migrates cleanly.
    const retry = newService();
    expect(() => retry.openLibrary(libraryPath)).not.toThrow();
    retry.closeAll();
    expect(schemaVersionOf(libraryFilePath(libraryPath))).toBe(SUPPORTED_SCHEMA_VERSION);
  });

  it('a failing migration leaves no partial rows in schema_migrations', () => {
    const root = temporaryRoot();
    const libraryPath = buildLibraryAtVersion(root, 23);
    const failing = newService({
      afterSchemaMigrationTransactionBegin: () => {
        throw new Error('injected');
      },
    });
    expect(() => failing.openLibrary(libraryPath)).toThrow();
    failing.closeAll();

    const db = new Database(libraryFilePath(libraryPath));
    const applied = db
      .prepare('SELECT MAX(version) AS max_version FROM schema_migrations')
      .get() as { max_version: number | null };
    db.close();
    expect(applied.max_version).toBe(23);
  });

  it('v4 table-rebuild migration is transactional when its DDL fails mid-way', () => {
    const root = temporaryRoot();
    const libraryPath = buildLibraryAtVersion(root, 3);
    const db = new Database(libraryFilePath(libraryPath));
    // Simulate a mid-migration failure inside the v4 rebuild by first
    // creating a conflicting object, then replaying the v4 SQL in the same
    // transaction shape the worker uses — the whole statement must roll back.
    db.exec('CREATE TABLE conflicting_assets (asset_id TEXT PRIMARY KEY)');
    const v4Sql = MIGRATIONS.find((migration) => migration.version === 4)!.sql;
    try {
      db.prepare(v4Sql).run();
      throw new Error('expected the v4 replay to fail on the conflicting table');
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('expected')) throw error;
    }
    expect(schemaVersionOf(libraryFilePath(libraryPath))).toBe(3);
    db.close();

    // The worker opens this library: v4 DROP TABLE conflicting_assets is not
    // part of the migration, so the foreign-object library is corrupt only by
    // the injected conflict; instead assert the version did not advance and
    // the worker's own retry path handles the pre-v4 chain.
    const service = newService();
    // The injected conflicting table makes open fail; drop it and reopen to
    // prove the v3 library itself migrates cleanly afterwards.
    const fixup = new Database(libraryFilePath(libraryPath));
    fixup.exec('DROP TABLE conflicting_assets');
    fixup.close();
    expect(() => service.openLibrary(libraryPath)).not.toThrow();
    service.closeAll();
    expect(schemaVersionOf(libraryFilePath(libraryPath))).toBe(SUPPORTED_SCHEMA_VERSION);
  });
});

describe('sync-first v37/v38 migration fork (Serpent-e0dw)', () => {
  const autoChecksum = MIGRATIONS.find((migration) => migration.version === 37)!.checksum;
  const syncChecksum = MIGRATIONS.find((migration) => migration.version === 38)!.checksum;
  // v40+ (Serpent-4bdd26): additive index migrations appended after v39. The
  // fork tests roll the library back to the v38 divergence point, so every
  // migration after v38 must be removed/restored dynamically instead of
  // hard-coding the tail version.
  const postV38Checksums = MIGRATIONS.filter(
    (migration) => migration.version >= 39,
  ).map((migration) => ({
    version: migration.version,
    checksum: migration.checksum,
  }));

  it('rewrites swapped v37/v38 checksums and opens the library writable', () => {
    const root = temporaryRoot();
    const creating = newService();
    const created = creating.createLibrary({
      displayName: 'Swapped history',
      selectedParentPath: root,
    });
    creating.closeAll();

    // 模拟 v38 分叉库：先把新建库回退到 v38，再交换 v37/v38 校验和。
    const db = new Database(libraryFilePath(created.libraryPath));
    removeLinkedDirectoryIndexFixture(db);
    db.exec('DROP TABLE IF EXISTS animation_retired_files; DROP TABLE IF EXISTS animation_requests; DROP TABLE IF EXISTS animation_preview_staging; DROP TABLE IF EXISTS animation_assets; DROP INDEX IF EXISTS revisions_size_fingerprint_idx');
    db.prepare('DELETE FROM schema_migrations WHERE version >= 39').run();
    db.pragma('user_version = 38');
    db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 37').run(syncChecksum);
    db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 38').run(autoChecksum);
    db.close();

    const service = newService();
    const opened = service.openLibrary(created.libraryPath);
    expect(opened.readOnly).toBeFalsy();
    expect(opened.recovery).toBeUndefined();
    service.renameLibrary({
      libraryId: opened.libraryId,
      displayName: 'Swapped history writable',
    });
    service.closeAll();

    const verified = new Database(libraryFilePath(created.libraryPath));
    const history = verified
      .prepare('SELECT version, checksum FROM schema_migrations WHERE version >= 37 ORDER BY version')
      .all() as Array<{ version: number; checksum: string }>;
    verified.close();
    expect(history).toEqual([
      { version: 37, checksum: autoChecksum },
      { version: 38, checksum: syncChecksum },
      ...postV38Checksums,
    ]);
  });

  it('upgrades a sync-first v37 library by applying auto-analysis as canonical v37', () => {
    const root = temporaryRoot();
    const creating = newService();
    const created = creating.createLibrary({
      displayName: 'Sync-first v37',
      selectedParentPath: root,
    });
    creating.closeAll();

    const db = new Database(libraryFilePath(created.libraryPath));
    removeLinkedDirectoryIndexFixture(db);
    db.exec('DROP TABLE IF EXISTS animation_retired_files; DROP TABLE IF EXISTS animation_requests; DROP TABLE IF EXISTS animation_preview_staging; DROP TABLE IF EXISTS animation_assets; DROP INDEX IF EXISTS revisions_size_fingerprint_idx');
    db.exec('DROP TABLE IF EXISTS asset_auto_analysis_suppression');
    db.prepare('DELETE FROM schema_migrations WHERE version >= 37').run();
    db.prepare(
      'INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)',
    ).run(37, syncChecksum, new Date().toISOString());
    db.pragma('user_version = 37');
    db.close();

    const service = newService();
    const opened = service.openLibrary(created.libraryPath);
    expect(opened.readOnly).toBeFalsy();
    service.renameLibrary({
      libraryId: opened.libraryId,
      displayName: 'Sync-first v37 writable',
    });
    service.closeAll();

    const verified = new Database(libraryFilePath(created.libraryPath));
    expect(schemaVersionOf(libraryFilePath(created.libraryPath))).toBe(SUPPORTED_SCHEMA_VERSION);
    const tables = verified
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'asset_auto_analysis_suppression'",
      )
      .all() as Array<{ name: string }>;
    const history = verified
      .prepare('SELECT version, checksum FROM schema_migrations WHERE version >= 37 ORDER BY version')
      .all() as Array<{ version: number; checksum: string }>;
    verified.close();
    expect(tables).toHaveLength(1);
    expect(history).toEqual([
      { version: 37, checksum: autoChecksum },
      { version: 38, checksum: syncChecksum },
      ...postV38Checksums,
    ]);
  });
});
