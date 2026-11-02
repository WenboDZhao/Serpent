import { z } from 'zod';

export const animationSha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const id = z.string().min(1).max(255);
const key = z.string().min(1).max(128);
export const ANIMATION_CHUNK_BYTES = 1024 * 1024;

/** Rendering belongs to Codex/Aseprite. Serpent only validates and retains this recipe. */
export const animationRecipeSchema = z.strictObject({
  version: z.literal(1),
  actions: z.array(z.strictObject({
    name: z.string().min(1).max(128),
    frames: z.array(z.number().int().positive()).min(1).max(10_000),
    durationsMs: z.array(z.number().int().min(10).max(60_000)).min(1).max(10_000),
  }).refine((action) => action.frames.length === action.durationsMs.length, {
    message: 'Every selected frame needs an explicit duration.',
  })).min(1).max(2),
  combinations: z.array(z.strictObject({
    name: z.string().min(1).max(128),
    /** One-based layer hierarchy paths; omitted preserves authored visibility. */
    layers: z.array(z.array(z.number().int().positive()).min(1).max(32)).max(1024).optional(),
  })).min(1).max(4),
  crop: z.strictObject({
    x: z.number().int().nonnegative(), y: z.number().int().nonnegative(),
    width: z.number().int().positive(), height: z.number().int().positive(),
  }),
  layout: z.strictObject({
    columns: z.number().int().min(1).max(2),
    scale: z.number().int().min(1).max(16),
    padding: z.number().int().min(0).max(128),
  }),
  posterFrame: z.number().int().nonnegative().default(0),
}).refine((recipe) => recipe.posterFrame < recipe.actions.reduce((n, action) => n + action.frames.length, 0), {
  message: 'Poster frame must be inside the rendered timeline.',
});
export type AnimationRecipe = z.infer<typeof animationRecipeSchema>;

export const animationImportInputSchema = z.strictObject({
  sourcePath: z.string().min(1), previewPath: z.string().min(1),
  sourceSha256: animationSha256Schema, previewSha256: animationSha256Schema,
  recipe: animationRecipeSchema, generatorVersion: id,
  targetFolderId: id.optional(), idempotencyKey: key,
});
export const animationGetInputSchema = z.strictObject({ assetId: id });
export const animationReadInputSchema = z.strictObject({
  assetId: id, kind: z.enum(['source', 'preview']),
  offsetBytes: z.number().int().nonnegative().default(0),
  maxBytes: z.number().int().positive().max(512 * 1024).default(256 * 1024),
  expectedSha256: animationSha256Schema,
});
export const animationStageInputSchema = z.strictObject({
  assetId: id, stagingId: z.string().uuid(), expectedRevisionId: id,
  expectedSourceSha256: animationSha256Schema,
  offsetBytes: z.number().int().nonnegative(),
  dataBase64: z.string().min(1).max(4 * Math.ceil(ANIMATION_CHUNK_BYTES / 3)),
  complete: z.boolean(),
});
export const animationPublishInputSchema = z.strictObject({
  assetId: id, stagingId: z.string().uuid(), recipe: animationRecipeSchema,
  generatorVersion: id, previewSha256: animationSha256Schema, idempotencyKey: key,
});
export const animationCancelInputSchema = z.strictObject({ assetId: id, stagingId: z.string().uuid() });

export const animationGenerationSchema = z.strictObject({
  sourceRevisionId: id, sourceSha256: animationSha256Schema,
  recipeSha256: animationSha256Schema, previewSha256: animationSha256Schema,
  generatorVersion: id, generatedAt: z.string().min(1),
  byteSize: z.number().int().positive(), width: z.number().int().positive(), height: z.number().int().positive(),
});
export const animationInfoSchema = z.strictObject({
  assetId: id, currentRevisionId: id, sourceSha256: animationSha256Schema,
  previewArtifactId: id, posterArtifactId: id,
  previewMissing: z.boolean(), stale: z.boolean(),
  recipe: animationRecipeSchema, generation: animationGenerationSchema,
});
export type AnimationInfo = z.infer<typeof animationInfoSchema>;
export const animationReadResultSchema = z.strictObject({
  assetId: id, revisionId: id, sha256: animationSha256Schema,
  byteSize: z.number().int().nonnegative(), offsetBytes: z.number().int().nonnegative(),
  dataBase64: z.string(), truncated: z.boolean(),
});
export const animationStageResultSchema = z.strictObject({
  assetId: id, stagingId: z.string().uuid(), byteSize: z.number().int().nonnegative(), complete: z.boolean(),
});
export const animationCancelResultSchema = z.strictObject({ cancelled: z.literal(true) });

export const animationSummarySchema = z.strictObject({
  previewArtifactId: id, posterArtifactId: id, stale: z.boolean(),
});
