import type { FixtureManifest } from './contracts.js';
import { createRecipe } from './fixture-recipe.js';
import { profiles } from './profiles.js';
import { validateSyntheticDistribution } from './synthetic-provider.js';
import type { WorkerStageContext } from './diagnostics/worker-stage-context.js';
import { recordWorkerProgress, runWorkerStage } from './diagnostics/worker-stage-context.js';

function preflightContents(manifest: FixtureManifest, context?: WorkerStageContext): void {
  const texts = Array.from({ length: 128 }, (_, index) => `preflight-${index}`);
  let vectorsChecked = 0;
  let vectorsValidated = 0;
  try {
    for (const file of manifest.files) {
      const recipe = createRecipe(file.recipeIndex, profiles[manifest.profile].files, manifest.declarationsPerFile, file.variant);
      const bytes = Buffer.from(recipe.text, 'utf8');
      for (const row of file.legacyRows) texts.push(bytes.subarray(row.startByte, row.endByte).toString('utf8').trim());
      for (const row of file.structuredRows) texts.push(bytes.subarray(row.startByte, row.endByte).toString('utf8'));
    }
    for (const query of manifest.queries) if (typeof query.args.query === 'string') texts.push(query.args.query);
    validateSyntheticDistribution(texts, context === undefined ? undefined : {
      onVectorAttempted: () => {
        vectorsChecked += 1;
        recordWorkerProgress(context, { counterId: 'preflight.vectors_checked', value: vectorsChecked, unit: 'vectors', semantics: 'attempted', sampleReason: 'threshold' });
      },
      onVectorValidated: () => {
        vectorsValidated += 1;
        recordWorkerProgress(context, { counterId: 'preflight.vectors_locally_validated', value: vectorsValidated, unit: 'vectors', semantics: 'verified', sampleReason: 'threshold' });
      },
    });
  } finally {
    if (context !== undefined) {
      recordWorkerProgress(context, { counterId: 'preflight.raw_text_inputs', value: texts.length, unit: 'inputs', semantics: 'attempted', sampleReason: 'stage_end' });
      recordWorkerProgress(context, { counterId: 'preflight.unique_text_inputs', value: new Set(texts).size, unit: 'inputs', semantics: 'attempted', sampleReason: 'stage_end' });
      recordWorkerProgress(context, { counterId: 'preflight.vectors_checked', value: vectorsChecked, unit: 'vectors', semantics: 'attempted', sampleReason: 'stage_end' });
      recordWorkerProgress(context, { counterId: 'preflight.vectors_locally_validated', value: vectorsValidated, unit: 'vectors', semantics: 'verified', sampleReason: 'stage_end' });
    }
  }
}

export function preflightWorkload(manifest: FixtureManifest): void;
export function preflightWorkload(manifest: FixtureManifest, context: WorkerStageContext): Promise<void>;
export function preflightWorkload(manifest: FixtureManifest, context?: WorkerStageContext): void | Promise<void> {
  if (context === undefined) return preflightContents(manifest);
  return runWorkerStage(context, { stageId: 'S02_workload_preflight', operationId: context.operationId, attemptId: context.attemptId },
    () => preflightContents(manifest, context));
}
