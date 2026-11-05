import { createFixtureRecipe, fixtureProfiles } from './fixture-recipe.mjs';

export function measureFixtureSize(profile) {
  const dimensions = fixtureProfiles[profile];
  let utf8Bytes = 0;
  let declarations = 0;
  let imports = 0;
  let legacyRows = 0;
  let structuredRows = 0;

  for (let index = 0; index < dimensions.files; index += 1) {
    const recipe = createFixtureRecipe({
      index,
      fileCount: dimensions.files,
      declarationsPerFile: dimensions.declarationsPerFile,
    });
    const fileDeclarations = recipe.drafts.length;
    utf8Bytes += Buffer.byteLength(recipe.text, 'utf8');
    declarations += fileDeclarations;
    imports += 1;
    legacyRows += fileDeclarations + 1;
    structuredRows += fileDeclarations;
  }

  return Object.freeze({ files: dimensions.files, utf8Bytes, declarations, imports, legacyRows, structuredRows });
}
