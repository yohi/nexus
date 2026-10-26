import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FixtureFile, FixtureManifest, Profile } from './contracts.js';
import { fixtureManifestSchema } from './contracts.js';
import { createRecipe, describeRecipe, fixturePath, sha256 } from './fixture-recipe.js';
import { fixtureQueries } from './fixture-queries.js';
import { profiles } from './profiles.js';

function buildManifest(profile: Profile, files: readonly FixtureFile[]): FixtureManifest {
  const { files: originalFileCount, declarationsPerFile } = profiles[profile];
  const identity = {
    version: 'retrieval-performance-v1' as const, profile,
    bytes: files.reduce((total, file) => total + file.bytes, 0), declarationsPerFile,
    maxChunkChars: 4096 as const, provider: 'test' as const,
    model: 'nexus-synthetic-sha256-v1' as const, dimensions: 128 as const,
    files, queries: fixtureQueries(files, originalFileCount, declarationsPerFile),
  };
  return fixtureManifestSchema.parse({ ...identity, digest: sha256(JSON.stringify(identity)) });
}

async function writeRecipe(root: string, profile: Profile, index: number,
  variant: 'initial' | 'modified' = 'initial'): Promise<FixtureFile> {
  const { files, declarationsPerFile } = profiles[profile];
  const destination = join(root, fixturePath(index));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, createRecipe(index, files, declarationsPerFile, variant).text, 'utf8');
  return describeRecipe(index, files, declarationsPerFile, variant);
}

export async function generateFixture(root: string, profile: Profile): Promise<FixtureManifest> {
  const files: FixtureFile[] = [];
  for (let index = 0; index < profiles[profile].files; index += 1) {
    files.push(await writeRecipe(root, profile, index));
  }
  return buildManifest(profile, files);
}

export async function applyIncrement(root: string, manifest: FixtureManifest) {
  const first = manifest.files[0];
  const last = manifest.files.at(-1);
  if (first === undefined || last === undefined || first.path === last.path) throw new RangeError('fixture_too_small');
  const addedIndex = Math.max(...manifest.files.map((file) => file.recipeIndex)) + 1;
  const modified = await writeRecipe(root, manifest.profile, first.recipeIndex, 'modified');
  const added = await writeRecipe(root, manifest.profile, addedIndex);
  await rm(join(root, last.path));
  const files = manifest.files.filter((file) => file.path !== first.path && file.path !== last.path);
  return {
    manifest: buildManifest(manifest.profile, [modified, ...files, added]),
    events: [
      { type: 'added', filePath: added.path, contentHash: added.merkleHash },
      { type: 'modified', filePath: modified.path, contentHash: modified.merkleHash },
      { type: 'deleted', filePath: last.path },
    ] as const,
  };
}
