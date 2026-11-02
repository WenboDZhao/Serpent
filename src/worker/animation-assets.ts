import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readSync, realpathSync, rmSync, statSync, writeFileSync, writeSync,
} from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { z } from 'zod';

import {
  ANIMATION_CHUNK_BYTES, animationInfoSchema, animationRecipeSchema,
  type AnimationInfo, type animationImportInputSchema, type animationReadInputSchema,
  type animationStageInputSchema, type animationPublishInputSchema, type animationCancelInputSchema,
} from '../shared/animation-assets';
import type { AssetSummary } from '../shared/asset-types';
import type { PublicErrorCode } from '../shared/protocol/errors';

/** Additive migration: preview lifetime is the asset lifetime, not a revision cache lifetime. */
export const ANIMATION_ASSETS_SCHEMA_SQL = `
  CREATE TABLE animation_assets (
    asset_id TEXT PRIMARY KEY REFERENCES assets(asset_id) ON DELETE CASCADE,
    source_revision_id TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    recipe_json TEXT NOT NULL,
    generation_json TEXT NOT NULL,
    preview_artifact_id TEXT NOT NULL UNIQUE,
    poster_artifact_id TEXT NOT NULL UNIQUE,
    preview_path TEXT NOT NULL,
    poster_path TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL
  );
  CREATE TABLE animation_requests (
    request_key TEXT PRIMARY KEY,
    request_kind TEXT NOT NULL,
    input_sha256 TEXT NOT NULL,
    asset_id TEXT REFERENCES assets(asset_id) ON DELETE CASCADE,
    completed INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE animation_preview_staging (
    staging_id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
    source_revision_id TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    byte_size INTEGER NOT NULL DEFAULT 0,
    complete INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE animation_retired_files (file_path TEXT PRIMARY KEY);
  CREATE TRIGGER animation_assets_insert AFTER INSERT ON animation_assets BEGIN
    UPDATE library_change_sequence SET sequence = sequence + 1;
    UPDATE browse_change_sequence SET sequence = sequence + 1;
  END;
  CREATE TRIGGER animation_assets_update AFTER UPDATE ON animation_assets BEGIN
    UPDATE library_change_sequence SET sequence = sequence + 1;
    UPDATE browse_change_sequence SET sequence = sequence + 1;
  END;
  CREATE TRIGGER animation_assets_delete AFTER DELETE ON animation_assets BEGIN
    INSERT OR IGNORE INTO animation_retired_files VALUES (OLD.preview_path);
    INSERT OR IGNORE INTO animation_retired_files VALUES (OLD.poster_path);
    UPDATE library_change_sequence SET sequence = sequence + 1;
    UPDATE browse_change_sequence SET sequence = sequence + 1;
  END;
`;
export const ANIMATION_ASSETS_SCHEMA_CHECKSUM = createHash('sha256').update(ANIMATION_ASSETS_SCHEMA_SQL).digest('hex');

type Connection = {
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
    run(...args: unknown[]): { changes: number };
  };
  transaction<T>(operation: () => T): () => T;
};
export interface AnimationAssetContext {
  connection: Connection;
  libraryPath: string;
  resolveSource(assetId: string): string;
  importSource(sourcePath: string, targetFolderId?: string): string;
  error(code: PublicErrorCode): Error;
  changed(): void;
}
type AnimationRow = {
  asset_id: string; source_revision_id: string; source_sha256: string;
  recipe_json: string; generation_json: string; preview_artifact_id: string;
  poster_artifact_id: string; preview_path: string; poster_path: string; width: number; height: number;
};
type StageRow = {
  staging_id: string; asset_id: string; source_revision_id: string; source_sha256: string;
  byte_size: number; complete: number;
};
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
/** Canonical JSON is shared with the Skill; object insertion order cannot force a refresh. */
export function animationCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(animationCanonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${animationCanonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export function animationFileSha256(filePath: string): string {
  const descriptor = openSync(filePath, 'r');
  try {
    const digest = createHash('sha256');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const count = readSync(descriptor, chunk, 0, chunk.length, null);
      if (!count) break;
      digest.update(chunk.subarray(0, count));
    }
    return digest.digest('hex');
  } finally { closeSync(descriptor); }
}

export class AnimationAssetRepository {
  constructor(private readonly context: AnimationAssetContext) {}
  private get db() { return this.context.connection; }
  private fail(code: PublicErrorCode): never { throw this.context.error(code); }
  private get root() { return path.join(this.context.libraryPath, '.serpent', 'artifacts'); }
  private regular(filePath: string): string {
    if (!path.isAbsolute(filePath)) this.fail('INVALID_IMPORT_SOURCE');
    const entry = lstatSync(filePath);
    if (!entry.isFile() || entry.isSymbolicLink()) this.fail('INVALID_IMPORT_SOURCE');
    return filePath;
  }
  private ownedDirectory(directory: string): string {
    mkdirSync(directory, { recursive: true });
    if (lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== path.resolve(directory)) {
      this.fail('INVALID_LIBRARY_PATH');
    }
    return directory;
  }
  private source(assetId: string) {
    const row = this.db.prepare(`SELECT current_revision_id, availability, deleted_at, location_kind,
      relative_file_path FROM assets WHERE asset_id = ?`).get(assetId) as {
      current_revision_id: string; availability: string; deleted_at: string | null;
      location_kind: string; relative_file_path: string;
    } | undefined;
    if (!row || row.deleted_at || row.availability !== 'available') this.fail('ASSET_NOT_FOUND');
    if (row.location_kind !== 'managed') this.fail('ASSET_NOT_MANAGED');
    return { ...row, path: this.regular(this.context.resolveSource(assetId)) };
  }
  row(assetId: string): AnimationRow | undefined {
    // Lenient reads: old/read-only libraries simply have no animation associations.
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='animation_assets'").get()) return undefined;
    return this.db.prepare('SELECT * FROM animation_assets WHERE asset_id = ?').get(assetId) as AnimationRow | undefined;
  }
  info(assetId: string): AnimationInfo | null {
    const row = this.row(assetId);
    if (!row) return null;
    const source = this.source(assetId);
    const sourceSha256 = animationFileSha256(source.path);
    const generation = JSON.parse(row.generation_json) as AnimationInfo['generation'];
    const previewMissing = !existsSync(path.join(this.root, row.preview_path))
      || !existsSync(path.join(this.root, row.poster_path));
    return animationInfoSchema.parse({
      assetId, currentRevisionId: source.current_revision_id, sourceSha256,
      previewArtifactId: row.preview_artifact_id, posterArtifactId: row.poster_artifact_id,
      previewMissing, stale: previewMissing || sourceSha256 !== row.source_sha256,
      recipe: JSON.parse(row.recipe_json), generation,
    });
  }
  summaries(assets: readonly AssetSummary[]): AssetSummary[] {
    if (!assets.length || !this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='animation_assets'").get()) return [...assets];
    const rows: AnimationRow[] = [];
    for (let i = 0; i < assets.length; i += 200) {
      const ids = assets.slice(i, i + 200).map((asset) => asset.assetId);
      rows.push(...this.db.prepare(`SELECT asset_id, source_revision_id, preview_artifact_id, poster_artifact_id, width, height
        FROM animation_assets WHERE asset_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as AnimationRow[]);
    }
    const byId = new Map(rows.map((row) => [row.asset_id, row]));
    return assets.map((asset) => {
      const row = byId.get(asset.assetId);
      return row ? {
        ...asset, thumbnailStatus: 'ready' as const, thumbnailArtifactId: row.poster_artifact_id,
        width: row.width, height: row.height,
        animation: {
          previewArtifactId: row.preview_artifact_id, posterArtifactId: row.poster_artifact_id,
          stale: asset.currentRevisionId !== row.source_revision_id,
        },
      } : asset;
    });
  }
  artifactRows(artifactIds: readonly string[]): Array<{ artifact_id: string; file_path: string; kind: string }> {
    if (!artifactIds.length || !this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='animation_assets'").get()) return [];
    const placeholders = artifactIds.map(() => '?').join(',');
    return this.db.prepare(`SELECT p.preview_artifact_id AS artifact_id, p.preview_path AS file_path, 'thumbnail' AS kind
      FROM animation_assets p JOIN assets a ON a.asset_id=p.asset_id WHERE p.preview_artifact_id IN (${placeholders})
      UNION ALL SELECT p.poster_artifact_id, p.poster_path, 'thumbnail'
      FROM animation_assets p JOIN assets a ON a.asset_id=p.asset_id WHERE p.poster_artifact_id IN (${placeholders})`)
      .all(...artifactIds, ...artifactIds) as Array<{ artifact_id: string; file_path: string; kind: string }>;
  }
  decorateLayout<T extends { assetId: string }>(layout: readonly T[]): T[] {
    if (!layout.length || !this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='animation_assets'").get()) return [...layout];
    const byId = new Map<string, AnimationRow>();
    for (let i = 0; i < layout.length; i += 200) {
      const ids = layout.slice(i, i + 200).map((entry) => entry.assetId);
      const rows = this.db.prepare(`SELECT asset_id, poster_artifact_id, width, height FROM animation_assets
        WHERE asset_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as AnimationRow[];
      for (const row of rows) byId.set(row.asset_id, row);
    }
    return layout.map((entry) => {
      const row = byId.get(entry.assetId);
      return row ? { ...entry, width: row.width, height: row.height, previewArtifactId: row.poster_artifact_id } : entry;
    });
  }
  private request(key: string, kind: string, input: unknown) {
    const fingerprint = hash(animationCanonicalJson(input));
    const existing = this.db.prepare('SELECT * FROM animation_requests WHERE request_key=?').get(key) as {
      request_kind: string; input_sha256: string; asset_id: string | null; completed: number;
    } | undefined;
    if (existing && (existing.request_kind !== kind || existing.input_sha256 !== fingerprint)) this.fail('ANIMATION_IDEMPOTENCY_CONFLICT');
    if (!existing) this.db.prepare('INSERT INTO animation_requests(request_key,request_kind,input_sha256) VALUES(?,?,?)').run(key, kind, fingerprint);
    return existing;
  }
  private complete(key: string, assetId: string) {
    this.db.prepare('UPDATE animation_requests SET asset_id=?, completed=1 WHERE request_key=?').run(assetId, key);
  }
  private assertSource(assetId: string, revisionId: string, sha256: string) {
    const source = this.source(assetId);
    if (source.current_revision_id !== revisionId || animationFileSha256(source.path) !== sha256) this.fail('ANIMATION_SOURCE_CHANGED');
    return source;
  }
  async importBundle(input: z.infer<typeof animationImportInputSchema>): Promise<AnimationInfo> {
    const previous = this.request(input.idempotencyKey, 'import', input);
    if (previous?.completed && previous.asset_id) return this.info(previous.asset_id)!;
    if (!/\.(aseprite|ase)$/iu.test(input.sourcePath)) this.fail('INVALID_IMPORT_SOURCE');
    if (animationFileSha256(this.regular(input.sourcePath)) !== input.sourceSha256) this.fail('ANIMATION_SOURCE_CHANGED');
    const recipe = animationRecipeSchema.parse(input.recipe);
    // Validate/decode before importing the source; a bad GIF never creates a catalog card.
    const prepared = await this.preparePreview(this.regular(input.previewPath), input.previewSha256, recipe.posterFrame);
    try {
      const assetId = previous?.asset_id ?? this.context.importSource(input.sourcePath, input.targetFolderId);
      this.db.prepare('UPDATE animation_requests SET asset_id=? WHERE request_key=?').run(assetId, input.idempotencyKey);
      const source = this.source(assetId);
      this.assertSource(assetId, source.current_revision_id, input.sourceSha256);
      this.commitPreview(assetId, source.current_revision_id, input.sourceSha256, recipe, input.generatorVersion, prepared, input.idempotencyKey);
      this.context.changed();
      return this.info(assetId)!;
    } catch (error) {
      this.removePrepared(prepared);
      throw error;
    }
  }
  read(input: z.infer<typeof animationReadInputSchema>) {
    const source = this.source(input.assetId);
    const row = this.row(input.assetId);
    if (!row) this.fail('ASSET_NOT_FOUND');
    const filePath = input.kind === 'source' ? source.path : this.regular(path.join(this.root, row.preview_path));
    const sha256 = animationFileSha256(filePath);
    if (sha256 !== input.expectedSha256) this.fail('ANIMATION_SOURCE_CHANGED');
    const byteSize = statSync(filePath).size;
    const offsetBytes = Math.min(byteSize, input.offsetBytes);
    const data = Buffer.alloc(Math.min(input.maxBytes, byteSize - offsetBytes));
    const descriptor = openSync(filePath, 'r');
    let count: number;
    try { count = readSync(descriptor, data, 0, data.length, offsetBytes); }
    finally { closeSync(descriptor); }
    if (animationFileSha256(filePath) !== sha256) this.fail('ANIMATION_SOURCE_CHANGED');
    return { assetId: input.assetId, revisionId: source.current_revision_id, sha256, byteSize,
      offsetBytes, dataBase64: data.subarray(0, count).toString('base64'), truncated: offsetBytes + count < byteSize };
  }
  private stagePath(stagingId: string) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(stagingId)) this.fail('INVALID_ASSET_METADATA');
    return path.join(this.ownedDirectory(path.join(this.context.libraryPath, '.serpent', 'animation-staging')), `${stagingId}.gif`);
  }
  stage(input: z.infer<typeof animationStageInputSchema>) {
    this.assertSource(input.assetId, input.expectedRevisionId, input.expectedSourceSha256);
    if (input.dataBase64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(input.dataBase64)) this.fail('INVALID_ASSET_METADATA');
    const data = Buffer.from(input.dataBase64, 'base64');
    if (!data.length || data.length > ANIMATION_CHUNK_BYTES) this.fail('INVALID_ASSET_METADATA');
    const row = this.db.prepare('SELECT * FROM animation_preview_staging WHERE staging_id=?').get(input.stagingId) as StageRow | undefined;
    if (row && (row.asset_id !== input.assetId || row.source_revision_id !== input.expectedRevisionId || row.source_sha256 !== input.expectedSourceSha256)) this.fail('ANIMATION_SOURCE_CHANGED');
    if (!row && input.offsetBytes !== 0) this.fail('INVALID_ASSET_METADATA');
    const destination = this.stagePath(input.stagingId);
    if (!row) this.db.prepare('INSERT INTO animation_preview_staging(staging_id,asset_id,source_revision_id,source_sha256) VALUES(?,?,?,?)')
      .run(input.stagingId, input.assetId, input.expectedRevisionId, input.expectedSourceSha256);
    if (!existsSync(destination)) {
      if (row?.byte_size) this.fail('ANIMATION_STAGING_INCOMPLETE');
      writeFileSync(destination, Buffer.alloc(0), { flag: 'wx' });
    }
    this.regular(destination);
    const size = statSync(destination).size;
    const end = input.offsetBytes + data.length;
    if (input.offsetBytes > size) this.fail('ANIMATION_STAGING_INCOMPLETE');
    const descriptor = openSync(destination, 'r+');
    try {
      if (input.offsetBytes < size) {
        if (end > size) this.fail('ANIMATION_STAGING_INCOMPLETE');
        const prior = Buffer.alloc(data.length);
        readSync(descriptor, prior, 0, prior.length, input.offsetBytes);
        if (!prior.equals(data)) this.fail('ANIMATION_IDEMPOTENCY_CONFLICT');
      } else {
        if (row?.complete) this.fail('ANIMATION_STAGING_INCOMPLETE');
        let written = 0;
        while (written < data.length) written += writeSync(descriptor, data, written, data.length - written, input.offsetBytes + written);
        fsyncSync(descriptor);
      }
    } finally { closeSync(descriptor); }
    const byteSize = Math.max(size, end);
    if (input.complete && end !== byteSize) this.fail('ANIMATION_STAGING_INCOMPLETE');
    const complete = Boolean(row?.complete || input.complete);
    this.db.prepare('UPDATE animation_preview_staging SET byte_size=?,complete=? WHERE staging_id=?').run(byteSize, complete ? 1 : 0, input.stagingId);
    return { assetId: input.assetId, stagingId: input.stagingId, byteSize, complete };
  }
  cancel(input: z.infer<typeof animationCancelInputSchema>) {
    const row = this.db.prepare('SELECT * FROM animation_preview_staging WHERE staging_id=?').get(input.stagingId) as StageRow | undefined;
    if (row && row.asset_id !== input.assetId) this.fail('ASSET_NOT_FOUND');
    if (row) {
      const filePath = this.stagePath(input.stagingId);
      if (existsSync(filePath)) this.regular(filePath);
      rmSync(filePath, { force: true });
      this.db.prepare('DELETE FROM animation_preview_staging WHERE staging_id=?').run(input.stagingId);
    }
    return { cancelled: true as const };
  }
  async publish(input: z.infer<typeof animationPublishInputSchema>): Promise<AnimationInfo> {
    const previous = this.request(input.idempotencyKey, 'publish', input);
    if (previous?.completed && previous.asset_id) return this.info(previous.asset_id)!;
    const row = this.db.prepare('SELECT * FROM animation_preview_staging WHERE staging_id=?').get(input.stagingId) as StageRow | undefined;
    if (!row || row.asset_id !== input.assetId || !row.complete) this.fail('ANIMATION_STAGING_INCOMPLETE');
    this.assertSource(row.asset_id, row.source_revision_id, row.source_sha256);
    const stagedPath = this.regular(this.stagePath(input.stagingId));
    if (statSync(stagedPath).size !== row.byte_size) this.fail('ANIMATION_STAGING_INCOMPLETE');
    const prepared = await this.preparePreview(stagedPath, input.previewSha256, input.recipe.posterFrame);
    try {
      // Decode yields to other Worker work. Fence again immediately before the synchronous commit.
      this.assertSource(row.asset_id, row.source_revision_id, row.source_sha256);
      this.commitPreview(row.asset_id, row.source_revision_id, row.source_sha256, input.recipe, input.generatorVersion, prepared, input.idempotencyKey);
    } catch (error) { this.removePrepared(prepared); throw error; }
    // Publication is durable even if optional staging cleanup fails. A retry returns the committed result.
    try { this.cancel({ assetId: input.assetId, stagingId: input.stagingId }); } catch { /* Recoverable staging remains. */ }
    this.context.changed();
    return this.info(input.assetId)!;
  }
  private async preparePreview(source: string, expectedHash: string, posterFrame: number) {
    const header = Buffer.alloc(6);
    const sourceDescriptor = openSync(source, 'r');
    try { readSync(sourceDescriptor, header, 0, 6, 0); } finally { closeSync(sourceDescriptor); }
    if (!['GIF89a', 'GIF87a'].includes(header.toString('ascii'))) this.fail('ANIMATION_INVALID_PREVIEW');
    if (animationFileSha256(source) !== expectedHash) this.fail('ANIMATION_INVALID_PREVIEW');
    this.ownedDirectory(this.root);
    const previewId = randomUUID();
    const posterId = randomUUID();
    const previewPath = `${previewId}.gif`;
    const posterPath = `${posterId}.png`;
    const prepared = { previewId, posterId, previewPath, posterPath, previewHash: expectedHash, width: 0, height: 0, byteSize: 0 };
    try {
      copyFileSync(source, path.join(this.root, previewPath));
      if (animationFileSha256(path.join(this.root, previewPath)) !== expectedHash) this.fail('ANIMATION_INVALID_PREVIEW');
      const metadata = await sharp(path.join(this.root, previewPath)).metadata();
      if (metadata.format !== 'gif' || !metadata.width || !metadata.height || posterFrame >= (metadata.pages ?? 1)) this.fail('ANIMATION_INVALID_PREVIEW');
      // Validate every compressed frame before Codex is allowed to discard its recovery copy.
      // Decode one frame at a time rather than allocating the entire animation strip.
      for (let page = 0; page < (metadata.pages ?? 1); page++) {
        await sharp(path.join(this.root, previewPath), { page, pages: 1 }).stats();
      }
      await sharp(path.join(this.root, previewPath), { page: posterFrame, pages: 1 }).png().toFile(path.join(this.root, posterPath));
      prepared.width = metadata.width;
      prepared.height = metadata.pageHeight ?? metadata.height;
      prepared.byteSize = statSync(path.join(this.root, previewPath)).size;
      // Flush both immutable files before publishing their references in SQLite.
      for (const name of [previewPath, posterPath]) {
        const descriptor = openSync(path.join(this.root, name), 'r');
        try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
      }
      return prepared;
    } catch (error) { this.removePrepared(prepared); throw error; }
  }
  private removePrepared(prepared: { previewPath: string; posterPath: string }) {
    for (const name of [prepared.previewPath, prepared.posterPath]) rmSync(path.join(this.root, name), { force: true });
  }
  private reapRetired() {
    const rows = this.db.prepare('SELECT file_path FROM animation_retired_files').all() as Array<{ file_path: string }>;
    for (const row of rows) {
      if (!/^[a-f0-9-]+\.(gif|png)$/iu.test(row.file_path)) continue;
      try {
        const target = path.join(this.root, row.file_path);
        if (existsSync(target)) this.regular(target);
        rmSync(target, { force: true });
        this.db.prepare('DELETE FROM animation_retired_files WHERE file_path=?').run(row.file_path);
      } catch { /* Locked files remain durably queued for the next publication. */ }
    }
  }
  private commitPreview(assetId: string, revisionId: string, sourceHash: string, recipe: AnimationInfo['recipe'],
    generatorVersion: string, prepared: Awaited<ReturnType<AnimationAssetRepository['preparePreview']>>, key: string) {
    const generation = {
      sourceRevisionId: revisionId, sourceSha256: sourceHash, recipeSha256: hash(animationCanonicalJson(recipe)),
      previewSha256: prepared.previewHash, generatorVersion, generatedAt: new Date().toISOString(),
      byteSize: prepared.byteSize, width: prepared.width, height: prepared.height,
    };
    this.db.transaction(() => {
      this.assertSource(assetId, revisionId, sourceHash);
      const previous = this.row(assetId);
      if (previous) {
        const retire = this.db.prepare('INSERT OR IGNORE INTO animation_retired_files VALUES (?)');
        retire.run(previous.preview_path); retire.run(previous.poster_path);
      }
      this.db.prepare(`INSERT INTO animation_assets(asset_id,source_revision_id,source_sha256,recipe_json,generation_json,
        preview_artifact_id,poster_artifact_id,preview_path,poster_path,width,height) VALUES(?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(asset_id) DO UPDATE SET source_revision_id=excluded.source_revision_id,source_sha256=excluded.source_sha256,
        recipe_json=excluded.recipe_json,generation_json=excluded.generation_json,preview_artifact_id=excluded.preview_artifact_id,
        poster_artifact_id=excluded.poster_artifact_id,preview_path=excluded.preview_path,poster_path=excluded.poster_path,width=excluded.width,height=excluded.height`)
        .run(assetId, revisionId, sourceHash, animationCanonicalJson(recipe), JSON.stringify(generation),
          prepared.previewId, prepared.posterId, prepared.previewPath, prepared.posterPath, prepared.width, prepared.height);
      this.complete(key, assetId);
    })();
    this.reapRetired();
  }
}
