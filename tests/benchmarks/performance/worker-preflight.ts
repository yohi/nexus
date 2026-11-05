import type { FixtureManifest } from './contracts.js';
import { createRecipe } from './fixture-recipe.js';
import { profiles } from './profiles.js';
import { validateSyntheticDistribution } from './synthetic-provider.js';

export function preflightWorkload(manifest: FixtureManifest): void {
  const texts = Array.from({ length: 128 }, (_, index) => `preflight-${index}`);
  for (const file of manifest.files) {
    const recipe = createRecipe(file.recipeIndex, profiles[manifest.profile].files, manifest.declarationsPerFile, file.variant);
    const bytes = Buffer.from(recipe.text, 'utf8');
    for (const row of file.legacyRows) texts.push(bytes.subarray(row.startByte, row.endByte).toString('utf8').trim());
    for (const row of file.structuredRows) texts.push(bytes.subarray(row.startByte, row.endByte).toString('utf8'));
  }
  for (const query of manifest.queries) if (typeof query.args.query === 'string') texts.push(query.args.query);
  validateSyntheticDistribution(texts);
}
