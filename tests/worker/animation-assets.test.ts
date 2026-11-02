import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { LibraryService } from '../../src/worker/library-service';
import { animationFileSha256 } from '../../src/worker/animation-assets';
import { animationRecipeSchema } from '../../src/shared/animation-assets';
import { executeAnimationAssetCommand } from '../../src/worker/handlers/animation-assets';
import { dispatchAutomationReadOnlyRequest } from '../../src/worker/automation-readonly-dispatch';

const roots: string[] = [];
const services: LibraryService[] = [];
afterEach(() => {
  services.splice(0).forEach((service) => service.closeAll());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
const recipe = animationRecipeSchema.parse({
  version: 1, actions: [{ name: 'idle', frames: [1], durationsMs: [80] }],
  combinations: [{ name: 'original' }], crop: { x: 0, y: 0, width: 4, height: 4 },
  layout: { columns: 1, scale: 1, padding: 0 }, posterFrame: 0,
});
async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'serpent-animation-')); roots.push(root);
  const service = new LibraryService(); services.push(service);
  const library = service.createLibrary({ displayName: 'Animations', selectedParentPath: root });
  const sourcePath = path.join(root, 'human.aseprite');
  // Minimal opaque source: Serpent must not parse or generate Aseprite contents.
  writeFileSync(sourcePath, Buffer.from('aseprite fixture source'));
  const previewPath = path.join(root, 'human.gif');
  await sharp({ create: { width: 4, height: 4, channels: 4, background: '#ff0000' } }).gif().toFile(previewPath);
  const input = { sourcePath, previewPath, sourceSha256: animationFileSha256(sourcePath),
    previewSha256: animationFileSha256(previewPath), recipe, generatorVersion: 'test/1', idempotencyKey: randomUUID() };
  const repo = () => service.animationRepository(library.libraryId, true);
  return { root, service, library, input, repo };
}
async function stage(f: Awaited<ReturnType<typeof fixture>>, assetId: string, data = readFileSync(f.input.previewPath)) {
  const info = f.repo().info(assetId)!;
  const input = { assetId, stagingId: randomUUID(), expectedRevisionId: info.currentRevisionId,
    expectedSourceSha256: info.sourceSha256, offsetBytes: 0, dataBase64: data.toString('base64'), complete: true };
  f.repo().stage(input);
  return input;
}
describe('managed animation assets', () => {
  it('imports one card, retries without scratch, serves still/GIF, and survives rename and restart', async () => {
    const f = await fixture();
    const info = await f.repo().importBundle(f.input);
    expect(info.stale).toBe(false);
    expect(f.service.listAssets({ libraryId: f.library.libraryId, recursive: true })).toMatchObject([
      { assetId: info.assetId, animation: { previewArtifactId: info.previewArtifactId }, thumbnailArtifactId: info.posterArtifactId },
    ]);
    expect(f.service.getPreviewArtifact(f.library.libraryId, info.assetId)).toMatchObject({ mediaType: 'image', mimeType: 'image/gif', artifactId: info.previewArtifactId });
    const gif = f.service.getArtifactAbsolutePath(f.library.libraryId, info.previewArtifactId, 'preview');
    expect(animationFileSha256(gif)).toBe(f.input.previewSha256);
    const poster = f.service.getArtifactAbsolutePath(f.library.libraryId, info.posterArtifactId, 'preview');
    expect((await sharp(poster).metadata()).format).toBe('png');
    rmSync(f.input.sourcePath); rmSync(f.input.previewPath);
    expect((await f.repo().importBundle(f.input)).assetId).toBe(info.assetId);
    f.service.renameAssetFile({ libraryId: f.library.libraryId, assetId: info.assetId, newBaseName: 'renamed' });
    const folder = f.service.createManagedFolder({ libraryId: f.library.libraryId, name: 'Characters' });
    f.service.moveAssets({ libraryId: f.library.libraryId, assetIds: [info.assetId], targetFolderId: folder.folderId });
    expect(f.repo().info(info.assetId)?.previewArtifactId).toBe(info.previewArtifactId);
    f.service.closeAll();
    f.service.openLibrary(f.library.libraryPath);
    expect(f.repo().info(info.assetId)).toMatchObject({ previewMissing: false, stale: false });
    expect(existsSync(f.service.getArtifactAbsolutePath(f.library.libraryId, info.previewArtifactId))).toBe(true);
    expect(f.service.resolveAssetPath(f.library.libraryId, info.assetId)).toContain('renamed.aseprite');
  });
  it('publishes a large chunked GIF idempotently, keeps metadata and source bytes, and cancels safely', async () => {
    const f = await fixture(); const info = await f.repo().importBundle(f.input);
    f.service.setAssetsRating({ libraryId: f.library.libraryId, assetIds: [info.assetId], rating: 4 });
    const metadata = f.service.getAssetMetadata({ libraryId: f.library.libraryId, assetId: info.assetId });
    f.service.setAssetMetadata({ libraryId: f.library.libraryId, assetId: info.assetId, expectedVersion: metadata.entityVersion, favorite: true });
    const tag = f.service.createTag({ libraryId: f.library.libraryId, name: 'Character' });
    f.service.assignTags({ libraryId: f.library.libraryId, assetIds: [info.assetId], tagIds: [tag.tagId] });
    const original = readFileSync(f.service.resolveAssetPath(f.library.libraryId, info.assetId));
    const bytes = await sharp(randomBytes(1024 * 1024 * 3), { raw: { width: 1024, height: 1024, channels: 3 } })
      .gif({ effort: 1 }).toBuffer();
    expect(bytes.length).toBeGreaterThan(1024 * 1024);
    const upload = await stage(f, info.assetId, bytes.subarray(0, 700_000));
    // Start again with incomplete first chunk and explicitly repeat the same bytes.
    f.repo().cancel({ assetId: info.assetId, stagingId: upload.stagingId });
    upload.complete = false;
    expect(f.repo().stage(upload).byteSize).toBe(700_000);
    expect(f.repo().stage(upload).byteSize).toBe(700_000);
    for (let offset = 700_000; offset < bytes.length; offset += 700_000) {
      const chunk = bytes.subarray(offset, offset + 700_000);
      f.repo().stage({ ...upload, offsetBytes: offset, dataBase64: chunk.toString('base64'), complete: offset + chunk.length === bytes.length });
    }
    const previewSha256 = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
    const publish = { assetId: info.assetId, stagingId: upload.stagingId, recipe, generatorVersion: 'test/2', previewSha256, idempotencyKey: randomUUID() };
    const updated = await f.repo().publish(publish);
    expect(updated.generation.byteSize).toBe(bytes.length);
    expect((await f.repo().publish(publish)).previewArtifactId).toBe(updated.previewArtifactId);
    expect(readFileSync(f.service.resolveAssetPath(f.library.libraryId, info.assetId))).toEqual(original);
    expect(f.service.listAssets({ libraryId: f.library.libraryId, recursive: true })[0]?.rating).toBe(4);
    const updatedMetadata = f.service.getAssetMetadata({ libraryId: f.library.libraryId, assetId: info.assetId });
    expect(updatedMetadata.favorite).toBe(true);
    expect(updatedMetadata.tags).toEqual(expect.arrayContaining([expect.objectContaining({ id: tag.tagId })]));
    const cancelled = await stage(f, info.assetId);
    expect(f.repo().cancel(cancelled)).toEqual({ cancelled: true });
    expect(f.repo().cancel(cancelled)).toEqual({ cancelled: true });
    await expect(f.repo().publish({ ...publish, stagingId: cancelled.stagingId, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'ANIMATION_STAGING_INCOMPLETE' });
  });
  it('rejects changed source bytes even before scanning and retains the last successful preview', async () => {
    const f = await fixture(); const info = await f.repo().importBundle(f.input);
    const upload = await stage(f, info.assetId);
    writeFileSync(f.service.resolveAssetPath(f.library.libraryId, info.assetId), 'new source contents');
    await expect(f.repo().publish({ assetId: info.assetId, stagingId: upload.stagingId, recipe, generatorVersion: 'test/2', previewSha256: f.input.previewSha256, idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: 'ANIMATION_SOURCE_CHANGED' });
    expect(f.repo().info(info.assetId)).toMatchObject({ stale: true, previewArtifactId: info.previewArtifactId });
    expect(existsSync(f.service.getArtifactAbsolutePath(f.library.libraryId, info.previewArtifactId))).toBe(true);
    f.service.refreshManagedAssets(f.library.libraryId);
    expect(f.service.listAssets({ libraryId: f.library.libraryId, recursive: true })[0]?.animation?.stale).toBe(true);
    const refreshed = await stage(f, info.assetId);
    const updated = await f.repo().publish({ assetId: info.assetId, stagingId: refreshed.stagingId, recipe,
      generatorVersion: 'test/2', previewSha256: f.input.previewSha256, idempotencyKey: randomUUID() });
    expect(updated).toMatchObject({ assetId: info.assetId, stale: false });
    expect(updated.generation.sourceSha256).not.toBe(info.generation.sourceSha256);
    expect(f.service.listAssets({ libraryId: f.library.libraryId, recursive: true })[0]?.animation?.stale).toBe(false);
  });
  it('fences a source write that occurs while the asynchronous decoder is running', async () => {
    const f = await fixture(); const info = await f.repo().importBundle(f.input);
    const upload = await stage(f, info.assetId);
    const publication = f.repo().publish({ assetId: info.assetId, stagingId: upload.stagingId, recipe, generatorVersion: 'test/2', previewSha256: f.input.previewSha256, idempotencyKey: randomUUID() });
    writeFileSync(f.service.resolveAssetPath(f.library.libraryId, info.assetId), 'concurrent editor write');
    await expect(publication).rejects.toMatchObject({ code: 'ANIMATION_SOURCE_CHANGED' });
    expect(f.repo().info(info.assetId)?.previewArtifactId).toBe(info.previewArtifactId);
  });
  it('rejects conflicting keys, bad config, missing chunks and corrupt previews without discarding old previews', async () => {
    const f = await fixture(); const info = await f.repo().importBundle(f.input);
    await expect(f.repo().importBundle({ ...f.input, generatorVersion: 'different' })).rejects.toMatchObject({ code: 'ANIMATION_IDEMPOTENCY_CONFLICT' });
    expect(animationRecipeSchema.safeParse({ ...recipe, combinations: Array(5).fill(recipe.combinations[0]) }).success).toBe(false);
    expect(animationRecipeSchema.safeParse({ ...recipe, actions: Array(3).fill(recipe.actions[0]) }).success).toBe(false);
    const upload = await stage(f, info.assetId);
    expect(() => f.repo().stage({ ...upload, dataBase64: Buffer.from('different bytes').toString('base64') })).toThrow();
    await expect(f.repo().publish({ assetId: info.assetId, stagingId: upload.stagingId, recipe, generatorVersion: 'test/2', previewSha256: '0'.repeat(64), idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'ANIMATION_INVALID_PREVIEW' });
    expect(f.repo().info(info.assetId)?.previewArtifactId).toBe(info.previewArtifactId);
  });
  it('exposes bounded hash-fenced source reads through the read-only dispatcher', async () => {
    const f = await fixture(); const imported = await executeAnimationAssetCommand(f.service, { ...f.input, libraryId: f.library.libraryId, type: 'animation.import' });
    expect(imported?.ok).toBe(true);
    const info = f.service.listAssets({ libraryId: f.library.libraryId, recursive: true })[0]!;
    const result = dispatchAutomationReadOnlyRequest(f.service, { requestId: randomUUID(), dispatch: 'automation-readonly', command: {
      type: 'animation.read', libraryId: f.library.libraryId, assetId: info.assetId, kind: 'source', offsetBytes: 2, maxBytes: 5, expectedSha256: f.input.sourceSha256,
    } });
    expect(result).toMatchObject({ ok: true, type: 'animation.read', truncated: true, dataBase64: readFileSync(f.input.sourcePath).subarray(2, 7).toString('base64') });
  });
});
