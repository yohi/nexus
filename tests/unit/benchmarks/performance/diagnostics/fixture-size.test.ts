import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { generateFixture } from '../../../../benchmarks/performance/fixtures.js';

type Profile = 'small' | 'medium';
type FixtureSizeSummary = Readonly<{
  files: number;
  utf8Bytes: number;
  declarations: number;
  imports: number;
  legacyRows: number;
  structuredRows: number;
}>;
type FixtureSizeModule = Readonly<{
  measureFixtureSize: (profile: Profile) => FixtureSizeSummary;
}>;
const roots: string[] = [];

function isFixtureSizeModule(value: unknown): value is FixtureSizeModule {
  return typeof value === 'object' && value !== null
    && 'measureFixtureSize' in value && typeof value.measureFixtureSize === 'function';
}

async function loadFixtureSizeModule(): Promise<FixtureSizeModule> {
  const moduleUrl = pathToFileURL(resolve(process.cwd(), 'scripts/performance-diagnostics/fixture-size.mjs')).href;
  let loaded: unknown;
  try {
    loaded = await import(moduleUrl);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    loaded = undefined;
  }
  expect(isFixtureSizeModule(loaded)).toBe(true);
  if (!isFixtureSizeModule(loaded)) throw new Error('fixture_size_estimator_missing');
  return loaded;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('generateFixture_preserves_the_known_small_profile_manifest', async () => {
  // Given: a fresh fixture root and the committed valid small-report identity.
  const root = await mkdtemp(join(tmpdir(), 'nexus-fixture-size-'));
  roots.push(root);

  // When: the ordinary benchmark fixture generator writes the small profile.
  const manifest = await generateFixture(root, 'small');

  // Then: its canonical identity and dimensions remain byte-for-byte compatible.
  expect(manifest).toMatchObject({
    digest: 'ec03dd3e1025fb34c382f66e86f702ae4474e931fa4bbcf743fc5c0fcc708c6a',
    bytes: 111_740,
    profile: 'small',
  });
  expect(manifest.files).toHaveLength(100);
});

it.each([
  {
    profile: 'small',
    expected: { files: 100, utf8Bytes: 111_740, declarations: 1_000, imports: 100, legacyRows: 1_100, structuredRows: 1_000 },
  },
  {
    profile: 'medium',
    expected: { files: 1_000, utf8Bytes: 1_084_640, declarations: 10_000, imports: 1_000, legacyRows: 11_000, structuredRows: 10_000 },
  },
] as const)('measureFixtureSize returns canonical $profile dimensions', async ({ profile, expected }) => {
  // Given: the committed retrieval-performance-v1 recipe's hand-checked dimensions.
  const fixtureSize = await loadFixtureSizeModule();

  // When: the offline estimator measures the selected profile.
  const actual = fixtureSize.measureFixtureSize(profile);

  // Then: it returns the canonical totals without generating fixture files.
  expect(actual).toEqual(expected);
});
