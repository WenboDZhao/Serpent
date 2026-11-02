import { describe, expect, it } from 'vitest';
import { createAutomationCommandGateway } from '../../src/automation/command-gateway';
import { automationCommandRegistry } from '../../src/automation/command-registry';
import { callSerpentMcpTool } from '../../src/mcp/call-tool';
import { listSerpentMcpTools } from '../../src/mcp/tool-catalog';
import { animationReadInputSchema, animationRecipeSchema, animationStageInputSchema } from '../../src/shared/animation-assets';
import { workerCommandSchema } from '../../src/shared/protocol/requests';
import { isCardHoverPreviewable } from '../../src/renderer/asset-card-hover-preview';
import { mcpContext, readExposure } from './serpent-mcp-test-fixtures';

describe('animation public contracts', () => {
  it('publishes all six explicit-library MCP tools and bounds reads below the output budget', () => {
    const tools = listSerpentMcpTools(readExposure).tools.filter((tool) => tool.name.startsWith('serpent_animation_'));
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'serpent_animation_get', 'serpent_animation_import', 'serpent_animation_preview_cancel',
      'serpent_animation_preview_publish', 'serpent_animation_preview_stage', 'serpent_animation_read',
    ]);
    for (const tool of tools) expect(tool.inputSchema.required).toContain('libraryId');
    const read = animationReadInputSchema.parse({ assetId: 'asset', kind: 'source', expectedSha256: 'a'.repeat(64) });
    expect(read.maxBytes).toBe(256 * 1024);
    expect(animationReadInputSchema.safeParse({ ...read, maxBytes: 1024 * 1024 }).success).toBe(false);
  });
  it('requires explicit frame timing and rejects too many actions or combinations', () => {
    const recipe = { version: 1, actions: [{ name: 'idle', frames: [1, 2], durationsMs: [80] }],
      combinations: [{ name: 'original' }], crop: { x: 0, y: 0, width: 4, height: 4 }, layout: { columns: 1, scale: 1, padding: 0 } };
    expect(animationRecipeSchema.safeParse(recipe).success).toBe(false);
    recipe.actions[0]!.durationsMs.push(80);
    expect(animationRecipeSchema.safeParse(recipe).success).toBe(true);
    expect(animationRecipeSchema.safeParse({ ...recipe, actions: Array(3).fill(recipe.actions[0]) }).success).toBe(false);
    expect(animationRecipeSchema.safeParse({ ...recipe, combinations: Array(5).fill(recipe.combinations[0]) }).success).toBe(false);
  });
  it('binds uploads to an asset, UUID token, source revision and content digest', () => {
    const input = { assetId: 'asset', stagingId: '00000000-0000-4000-8000-000000000001', expectedRevisionId: 'revision',
      expectedSourceSha256: 'b'.repeat(64), offsetBytes: 0, dataBase64: 'R0lGODlh', complete: false };
    expect(workerCommandSchema.parse({ ...input, type: 'animation.preview.stage', libraryId: 'library' })).toMatchObject(input);
    expect(animationStageInputSchema.safeParse({ ...input, stagingId: '../escaped' }).success).toBe(false);
    expect(animationStageInputSchema.safeParse({ ...input, expectedRevisionId: undefined }).success).toBe(false);
  });
  it('routes association reads through the read-only Gateway path with explicit library targeting', async () => {
    const calls: unknown[] = [];
    const context = mcpContext();
    const gateway = createAutomationCommandGateway({ request: async (command, options) => {
      calls.push({ command, options });
      return { ok: true, type: 'animation.got', animation: null };
    } }, { resolve: () => context });
    const result = await callSerpentMcpTool({ toolName: 'serpent_animation_get', arguments: { libraryId: 'library-1', assetId: 'asset' },
      context, exposure: readExposure, gateway });
    expect(result).toMatchObject({ ok: true, result: null });
    expect(calls).toEqual([expect.objectContaining({ command: { type: 'animation.get', libraryId: 'library-1', assetId: 'asset' }, options: expect.objectContaining({ readonly: true }) })]);
    const invalid = await callSerpentMcpTool({ toolName: 'serpent_animation_get', arguments: { assetId: 'asset' }, context, exposure: readExposure, gateway });
    expect(invalid.ok).toBe(false); expect(calls).toHaveLength(1);
    for (const descriptor of automationCommandRegistry.filter((entry) => entry.commandId.startsWith('animation.'))) {
      expect(descriptor.supportsUndo).toBe(false);
    }
  });
  it('uses the GIF hover path for associated Aseprite cards and preserves normal image behavior', () => {
    const source = { mediaType: 'other' as const, displayName: 'character.aseprite', animation: { previewArtifactId: 'gif' } };
    expect(isCardHoverPreviewable(source)).toBe(true);
    expect(isCardHoverPreviewable({ ...source, availability: 'missing' })).toBe(false);
    expect(isCardHoverPreviewable({ ...source, deletedAt: new Date().toISOString() })).toBe(false);
    expect(isCardHoverPreviewable({ mediaType: 'image', displayName: 'normal.png' })).toBe(false);
    expect(isCardHoverPreviewable({ mediaType: 'image', displayName: 'normal.gif' })).toBe(true);
  });
});
