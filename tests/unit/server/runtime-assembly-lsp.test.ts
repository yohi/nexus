import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../../src/config/index.js';
import type { Config } from '../../../src/types/index.js';
import { lspNavigationLockTimeoutMs } from '../../../src/lsp/navigation-service.js';
import { RuntimeLocalLspManager } from '../../../src/lsp/process-manager.js';
import { createRuntimeAssembly } from '../../../src/server/runtime-assembly.js';
import { createSyntheticProvider, syntheticEmbeddingConfig } from '../../benchmarks/performance/synthetic-provider.js';

const navigationServiceControl = vi.hoisted(() => ({ fail: false, lastOptions: undefined as unknown }));

vi.mock('../../../src/lsp/navigation-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lsp/navigation-service.js')>();
  class ControlledNavigationService extends actual.LspNavigationService {
    constructor(options: ConstructorParameters<typeof actual.LspNavigationService>[0]) {
      if (navigationServiceControl.fail) throw new Error('navigation_service_construction_failure');
      super(options);
      navigationServiceControl.lastOptions = options;
    }
  }
  return { ...actual, LspNavigationService: ControlledNavigationService };
});

describe('runtime assembly LSP ownership', () => {
  let directory: string;
  let root: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'nexus-runtime-assembly-lsp-'));
    root = join(directory, 'project');
    await mkdir(root);
    navigationServiceControl.fail = false;
    navigationServiceControl.lastOptions = undefined;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  const assemble = async (env: Record<string, string> = {}) => {
    const config = await loadConfig({ projectRoot: root, env });
    return createRuntimeAssembly({ ...config, embedding: syntheticEmbeddingConfig },
      { createEmbeddingProvider: createSyntheticProvider });
  };

  it('injects a runtime-local navigation service without exposing it on the public runtime', async () => {
    const close = vi.spyOn(RuntimeLocalLspManager.prototype, 'close');
    const assembly = await assemble({ NEXUS_LSP_STARTUP_TIMEOUT_MS: '30000', NEXUS_LSP_REQUEST_TIMEOUT_MS: '5000' });
    try {
      expect(assembly.options.lspNavigationService).toBeDefined();
      expect(Object.keys(assembly.runtime)).not.toContain('lspNavigationService');
      expect(navigationServiceControl.lastOptions).toMatchObject({ lockTimeoutMs: 36_000 });
    } finally {
      await assembly.runtime.close();
    }
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes the LSP manager and releases the project lock when construction fails after it was created', async () => {
    const close = vi.spyOn(RuntimeLocalLspManager.prototype, 'close');
    navigationServiceControl.fail = true;
    await expect(assemble()).rejects.toThrow('navigation_service_construction_failure');
    expect(close).toHaveBeenCalledTimes(1);
    navigationServiceControl.fail = false;
    const reopened = await assemble();
    await reopened.runtime.close();
  });

  it('starts with defaults when Config.lsp is absent and LSP reports unavailable/LSP_NOT_CONFIGURED', async () => {
    await writeFile(join(root, 'a.ts'), 'export const needle = 1;\n');
    const loaded = await loadConfig({ projectRoot: root, env: {} });
    // Simulates a Config built without loadConfig (e.g. by an embedder) that omits `lsp`.
    const { lsp: _omitted, ...withoutLsp } = loaded;
    const config = { ...withoutLsp, embedding: syntheticEmbeddingConfig } as unknown as Config;
    const assembly = await createRuntimeAssembly(config, { createEmbeddingProvider: createSyntheticProvider });
    try {
      expect(navigationServiceControl.lastOptions).toMatchObject({ lockTimeoutMs: lspNavigationLockTimeoutMs(loaded.lsp) });
      await assembly.runtime.initialize();
      const matches = await assembly.options.grepEngine.search({ query: 'needle', cwd: root });
      expect(matches.length).toBeGreaterThan(0);
      const navigation = await assembly.options.lspNavigationService?.navigate({
        kind: 'definition',
        args: { filePath: 'a.ts', line: 1, character: 13 },
      });
      expect(navigation).toMatchObject({ status: 'unavailable', reasonCode: 'LSP_NOT_CONFIGURED', locations: [] });
    } finally {
      await assembly.runtime.close();
    }
  });

  it('closes the LSP manager through runtime close even after initialization rejected', async () => {
    const close = vi.spyOn(RuntimeLocalLspManager.prototype, 'close');
    const assembly = await assemble();
    vi.spyOn(assembly.options.metadataStore, 'initialize').mockRejectedValueOnce(new Error('initialization_failure'));
    await expect(assembly.runtime.initialize()).rejects.toThrow('initialization_failure');
    await assembly.runtime.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
