import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as root from '../../../src/index.js';
import * as factory from '../../../src/server/factory.js';

describe('execution-base public exports', () => {
  it('preserves both exact runtime export sets without benchmark entry points', async () => {
    const snapshot = z.object({ root: z.array(z.string()), factory: z.array(z.string()) }).parse(
      JSON.parse(await readFile(new URL('../../fixtures/performance/public-exports.json', import.meta.url), 'utf8')),
    );
    expect(Object.keys(root).sort()).toEqual(snapshot.root);
    expect(Object.keys(factory).sort()).toEqual(snapshot.factory);
    expect(root.assertPackageModeConstraints).toBe(factory.assertPackageModeConstraints);
  });

  it('preserves package-mode validation through both public routes', async () => {
    const config = await root.loadConfig({ projectRoot: '.', env: {} });
    for (const validate of [root.assertPackageModeConstraints, factory.assertPackageModeConstraints]) {
      expect(() => validate({ ...config, packageMode: true })).toThrow('requires embedding.provider="bedrock"');
      expect(() => validate({ ...config, packageMode: true, embedding: { ...config.embedding, provider: 'bedrock' } })).not.toThrow();
    }
  });
});
