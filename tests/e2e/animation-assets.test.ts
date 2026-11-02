import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { _electron as electron, expect, test } from '@playwright/test';
import type { SerpentLibraryApi } from '../../src/shared/library-api';
import type { SerpentMcpSettingsApi } from '../../src/shared/mcp';
import { electronLaunchEnv, resolveElectronExecutablePath } from './electron-test-helpers';

const execute = promisify(execFile);
test.describe.configure({ timeout: 180_000 });
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const script = path.resolve('.agents/skills/aseprite-animation-assets/scripts/assets.py');

async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('No port')); return; }
      server.close(() => resolve(address.port));
    });
  });
}

test('animation MCP import, single-card GIF viewer, source open, Skill update/cleanup and restart', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'serpent-animation-e2e-'));
  const parent = process.env.SERPENT_ANIMATION_SAMPLE_LIBRARY_PARENT ?? root;
  const name = `动画资产验证-${Date.now()}`;
  const port = await freePort();
  writeFileSync(path.join(root, 'mcp-settings.json'), JSON.stringify({ version: 1, preferences: { enabled: true, autoStart: true, port } }));
  const applicationDirectory = process.env.SERPENT_E2E_APP_DIRECTORY ?? process.cwd();
  const launch = async () => {
    const application = await electron.launch({
      args: [applicationDirectory], cwd: applicationDirectory, executablePath: resolveElectronExecutablePath(),
      env: electronLaunchEnv({ SERPENT_E2E: '1', SERPENT_E2E_USER_DATA_PATH: root,
        SERPENT_E2E_CREATE_PARENT_PATH: parent, SERPENT_E2E_OPEN_LIBRARY_PATH: path.join(parent, name) }),
    });
    // Shipped builds intentionally ignore the unpackaged native-dialog seam.
    // Match packaged-startup's dialog stub when testing the real app bundle.
    await application.evaluate(({ app, dialog }, paths) => {
      if (!app.isPackaged) return;
      dialog.showOpenDialog = async (...args: unknown[]) => {
        const options = args.at(-1) as { title?: string };
        const isCreate = options.title === 'Create Library' || options.title === '创建资源库';
        return { canceled: false, filePaths: [isCreate ? paths.parent : paths.libraryPath] };
      };
    }, { parent, libraryPath: path.join(parent, name) });
    return application;
  };
  let application = await launch();
  let client: Client | undefined;
  try {
    let window = await application.firstWindow();
    await window.getByRole('button', { name: '创建资源库', exact: true }).click();
    await window.getByRole('textbox', { name: '名称', exact: true }).fill(name);
    await window.getByRole('button', { name: '创建', exact: true }).click();
    await expect(window.getByRole('button', { name: `当前资源库 ${name}`, exact: true }))
      .toBeVisible({ timeout: 15_000 });
    await window.evaluate(async () => {
      const response = await (globalThis as unknown as { serpent: { mcp: SerpentMcpSettingsApi } }).serpent.mcp.request({ type: 'create-client-config', input: { format: 'generic-json' } });
      if (!response.ok) throw new Error('Cannot create isolated MCP credential');
    });
    const connection = await application.evaluate(({ clipboard }) => clipboard.readText());
    const endpoint = connection.match(/^Endpoint: (https?:\/\/\S+)$/mu)?.[1];
    const token = connection.match(/^Authorization: Bearer (\S+)$/mu)?.[1];
    if (!endpoint || !token) throw new Error('No isolated MCP connection');
    client = new Client({ name: 'animation-e2e', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const call = async (tool: string, arguments_: Record<string, unknown>) => {
      const response = await client!.callTool({ name: tool, arguments: arguments_ });
      const text = response.content as Array<{ type: string; text?: string }>;
      const payload = response.structuredContent ?? JSON.parse(text.find((item) => item.type === 'text')!.text!);
      const parsed = payload as { ok: boolean; code?: string; message?: string; result: unknown };
      if (!parsed.ok) throw new Error(`${tool}: ${parsed.code} ${parsed.message}`);
      return parsed.result;
    };
    const libraries = await call('serpent_library_list_open', {}) as { libraries: Array<{ libraryId: string }> };
    const libraryId = libraries.libraries[0]!.libraryId;
    const sampleRun = process.env.SERPENT_ANIMATION_SAMPLE_RUN;
    let assetId: string;
    let sourceHash: string;
    const python = process.env.SERPENT_SKILL_PYTHON ?? 'python3';
    const childEnv = { ...process.env, SERPENT_MCP_URL: endpoint, SERPENT_MCP_TOKEN: token };
    if (sampleRun) {
      const run = JSON.parse(readFileSync(path.join(sampleRun, 'run.json'), 'utf8')) as { sourceSha256: string };
      sourceHash = run.sourceSha256;
      const result = await execute(python, [script, 'import', '--run', sampleRun, '--library', libraryId], { env: childEnv });
      assetId = (JSON.parse(result.stdout.trim()) as { assetId: string }).assetId;
      expect(existsSync(sampleRun)).toBe(false);
      const skipped = await execute(python, [script, 'update', '--aseprite', process.env.ASEPRITE_BIN!, '--library', libraryId, '--asset', assetId], { env: childEnv });
      expect(JSON.parse(skipped.stdout).status).toBe('skipped');
    } else {
      const source = path.join(root, 'character.aseprite'); writeFileSync(source, 'opaque Aseprite source');
      const gif = path.join(root, 'preview.gif');
      // Exercise the animated viewer with two distinct frames. A one-frame
      // GIF correctly opens in the static image viewer instead.
      const pixels = Buffer.from(Array.from({ length: 128 }, (_, pixel) =>
        pixel < 64 ? [239, 86, 35, 255] : [35, 86, 239, 255],
      ).flat());
      await sharp(pixels, { raw: { width: 8, height: 16, channels: 4, pageHeight: 8 } })
        .gif({ delay: [80, 80], loop: 0 }).toFile(gif);
      expect((await sharp(gif, { animated: true }).metadata()).pages).toBe(2);
      sourceHash = sha(source);
      const info = await call('serpent_animation_import', { libraryId, sourcePath: source, previewPath: gif, sourceSha256: sourceHash,
        previewSha256: sha(gif), generatorVersion: 'e2e/1', idempotencyKey: 'e2e-import',
        recipe: { version: 1, actions: [{ name: 'idle', frames: [1, 2], durationsMs: [80, 80] }], combinations: [{ name: 'authored' }],
          crop: { x: 0, y: 0, width: 8, height: 8 }, layout: { columns: 1, scale: 1, padding: 0 }, posterFrame: 0 },
      }) as { assetId: string };
      assetId = info.assetId;
      rmSync(source); rmSync(gif);
    }
    await window.keyboard.press('F5');
    const card = window.locator('.asset-card');
    await expect(card).toHaveCount(1);
    await expect(card.locator('img').first()).toBeVisible();
    await expect.poll(() => card.locator('img').first().evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const published = await call('serpent_animation_get', { libraryId, assetId }) as { previewArtifactId: string };
    await card.hover();
    await expect(card.locator(`img[src$="/${published.previewArtifactId}"]`)).toBeVisible();
    await expect.poll(() => card.locator('img').count()).toBeGreaterThanOrEqual(1);
    await expect.poll(() => card.evaluate((element) => element.querySelectorAll('img[src^="serpent://preview/"]').length)).toBeGreaterThan(0);
    await card.dblclick();
    const viewer = window.locator('.workspace-viewer:not([aria-hidden="true"])');
    await expect(viewer).toBeVisible();
    await expect(viewer.locator('.preview-video-stage canvas').first()).toBeVisible();
    await window.keyboard.press('Escape');
    // Capture OS dispatch inside the isolated Electron instance, without launching a user's editor.
    await application.evaluate(({ shell }) => {
      shell.openPath = async (filePath: string) => { (globalThis as unknown as { animationOpened: string }).animationOpened = filePath; return ''; };
    });
    const opened = await window.evaluate(({ libraryId, assetId }) => (globalThis as unknown as { serpent: { library: SerpentLibraryApi } }).serpent.library.openExternal({ libraryId, assetId }), { libraryId, assetId });
    expect(opened.ok).toBe(true);
    const sourcePath = await application.evaluate(() => (globalThis as unknown as { animationOpened: string }).animationOpened);
    expect(sourcePath).toContain(path.join(name, 'Assets'));
    expect(sha(sourcePath)).toBe(sourceHash);
    const before = await call('serpent_animation_get', { libraryId, assetId }) as { previewArtifactId: string; recipe: Record<string, unknown> };
    if (sampleRun) {
      const recipePath = path.join(root, 'updated-recipe.json');
      const nextRecipe = { ...before.recipe, layout: { ...(before.recipe.layout as object), padding: 5 } };
      writeFileSync(recipePath, JSON.stringify(nextRecipe));
      const update = await execute(python, [script, 'update', '--aseprite', process.env.ASEPRITE_BIN!, '--library', libraryId, '--asset', assetId,
        '--recipe', recipePath, '--work-parent', root], { env: childEnv });
      expect(JSON.parse(update.stdout).cleaned).toBe(true);
      expect(sha(sourcePath)).toBe(sourceHash);
      const refreshed = await call('serpent_animation_get', { libraryId, assetId }) as { previewArtifactId: string };
      expect(refreshed.previewArtifactId).not.toBe(before.previewArtifactId);
      await window.getByRole('button', { name: '所有资产', exact: true }).click();
      await card.hover();
      await expect(card.locator(`img[src$="/${refreshed.previewArtifactId}"]`)).toBeVisible();
    }
    await client.close(); client = undefined;
    await application.close();
    application = await launch(); window = await application.firstWindow();
    const openLibrary = window.getByRole('button', { name: '打开资源库', exact: true });
    const allAssets = window.getByRole('button', { name: '所有资产', exact: true });
    // The startup shell renders disabled navigation before it resolves the
    // start screen. Only enabled navigation means the library is ready.
    await expect.poll(async () => await openLibrary.isVisible() ||
      (await allAssets.isVisible() && await allAssets.isEnabled())).toBe(true);
    if (await openLibrary.isVisible()) await openLibrary.click();
    await allAssets.click();
    await expect(window.locator('.asset-card')).toHaveCount(1);
    await expect.poll(() => window.locator('.asset-card img').first().evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect(sha(sourcePath)).toBe(sourceHash);
  } finally {
    await client?.close();
    await application.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
