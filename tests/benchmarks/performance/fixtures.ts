import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FixtureFile, FixtureManifest, Profile } from './contracts.js';
import { fixtureManifestSchema } from './contracts.js';
import { createRecipe, describeRecipe, fixturePath, sha256 } from './fixture-recipe.js';
import { fixtureQueries } from './fixture-queries.js';
import { profiles } from './profiles.js';
import type { WorkerStageContext } from './diagnostics/worker-stage-context.js';
import { recordWorkerProgress, runWorkerStage } from './diagnostics/worker-stage-context.js';

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
  options: Readonly<{ variant?: 'initial' | 'modified'; onWritten?: (bytes: number) => void }> = {}): Promise<FixtureFile> {
  const variant = options.variant ?? 'initial';
  const { files, declarationsPerFile } = profiles[profile];
  const destination = join(root, fixturePath(index));
  await mkdir(dirname(destination), { recursive: true });
  const text = createRecipe(index, files, declarationsPerFile, variant).text;
  await writeFile(destination, text, { encoding: 'utf8', flag: variant === 'modified' ? 'w' : 'wx' });
  options.onWritten?.(Buffer.byteLength(text, 'utf8'));
  return describeRecipe(index, files, declarationsPerFile, variant);
}

async function generateFixtureContents(root: string, profile: Profile, context: WorkerStageContext): Promise<FixtureManifest> {
  const files: FixtureFile[] = [];
  let bytes = 0;
  let written = 0;
  try {
    for (let index = 0; index < profiles[profile].files; index += 1) {
      const file = await writeRecipe(root, profile, index, {
        onWritten: (fileBytes) => {
          written += 1;
          bytes += fileBytes;
          recordWorkerProgress(context, { counterId: 'fixture.files_written_succeeded', value: written, unit: 'files', semantics: 'succeeded', sampleReason: 'threshold' });
          recordWorkerProgress(context, { counterId: 'fixture.bytes_written', value: bytes, unit: 'bytes', semantics: 'succeeded', sampleReason: 'threshold' });
        },
      });
      files.push(file);
      recordWorkerProgress(context, { counterId: 'fixture.recipe_descriptions_succeeded', value: files.length, unit: 'occurrences', semantics: 'succeeded', sampleReason: 'threshold' });
    }
    return buildManifest(profile, files);
  } finally {
    recordWorkerProgress(context, { counterId: 'fixture.files_written_succeeded', value: written, unit: 'files', semantics: 'succeeded', sampleReason: 'stage_end' });
    recordWorkerProgress(context, { counterId: 'fixture.bytes_written', value: bytes, unit: 'bytes', semantics: 'succeeded', sampleReason: 'stage_end' });
    recordWorkerProgress(context, { counterId: 'fixture.recipe_descriptions_succeeded', value: files.length, unit: 'occurrences', semantics: 'succeeded', sampleReason: 'stage_end' });
  }
}

export async function generateFixture(root: string, profile: Profile, context?: WorkerStageContext): Promise<FixtureManifest> {
  if (context === undefined) {
    const files: FixtureFile[] = [];
    for (let index = 0; index < profiles[profile].files; index += 1) {
      files.push(await writeRecipe(root, profile, index));
    }
    return buildManifest(profile, files);
  }
  return await runWorkerStage(context, { stageId: 'S01_fixture_generation', operationId: context.operationId, attemptId: context.attemptId },
    async () => await generateFixtureContents(root, profile, context));
}

export async function applyIncrement(root: string, manifest: FixtureManifest) {
  const first = manifest.files[0];
  const last = manifest.files.at(-1);
  if (first === undefined || last === undefined || first.path === last.path) throw new RangeError('fixture_too_small');
  const addedIndex = Math.max(...manifest.files.map((file) => file.recipeIndex)) + 1;
  const modified = await writeRecipe(root, manifest.profile, first.recipeIndex, { variant: 'modified' });
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
