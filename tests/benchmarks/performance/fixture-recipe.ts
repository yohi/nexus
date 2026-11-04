import { createHash } from 'node:crypto';
import { computeStringHash } from '../../../src/indexer/hash.js';
import type { FixtureFile, ExpectedRow } from './contracts.js';
import { createFixtureRecipe, fixturePath } from '../../../scripts/performance-diagnostics/fixture-recipe.mjs';

export { fixturePath };

export const sha256 = (content: string | Uint8Array): string => createHash('sha256').update(content).digest('hex');

export function createRecipe(index: number, fileCount: number, declarationsPerFile: number,
  variant: 'initial' | 'modified' = 'initial') {
  return createFixtureRecipe({ index, fileCount, declarationsPerFile, variant });
}

export async function describeRecipe(index: number, fileCount: number, declarationsPerFile: number,
  variant: 'initial' | 'modified' = 'initial'): Promise<FixtureFile> {
  const recipe = createRecipe(index, fileCount, declarationsPerFile, variant);
  const path = fixturePath(index);
  const byteAt = (offset: number): number => Buffer.byteLength(recipe.text.slice(0, offset));
  const lineAt = (offset: number): number => recipe.text.slice(0, offset).split('\n').length;
  const declarations = recipe.drafts.map((draft) => ({
    name: draft.name, kind: 'function' as const, signature: `function ${draft.name} ( ) : string`,
    startByte: byteAt(draft.start), endByte: byteAt(draft.end),
    startLine: lineAt(draft.start), endLine: lineAt(draft.end), sourceHash: sha256(draft.content),
  }));
  const legacyRows: ExpectedRow[] = [];
  const structuredRows: ExpectedRow[] = [];
  for (const [position, draft] of recipe.drafts.entries()) {
    const declaration = declarations[position];
    if (declaration === undefined) throw new RangeError('missing_recipe_declaration');
    const row = {
      name: declaration.name, kind: declaration.kind, startByte: declaration.startByte,
      endByte: declaration.endByte, startLine: declaration.startLine, endLine: declaration.endLine,
      sourceHash: declaration.sourceHash,
    };
    const legacyContent = recipe.text.slice(draft.fullStart, draft.end).trim();
    const startLine = lineAt(draft.fullStart);
    const endLine = startLine + legacyContent.split('\n').length - 1;
    legacyRows.push({
      ...row, startLine, endLine,
      startByte: byteAt(draft.fullStart), key: `${path}:${startLine}-${endLine}:${draft.name}`,
      sourceHash: sha256(legacyContent), contentHash: await computeStringHash(legacyContent),
    });
    structuredRows.push({
      ...row, key: `${path}:${declaration.startLine}-${declaration.endLine}:${draft.name}`,
      contentHash: await computeStringHash(draft.content),
    });
  }
  legacyRows.unshift({
    key: `${path}:1-1:imports`, name: 'imports', kind: 'import',
    startLine: 1, endLine: 1, startByte: 0, endByte: Buffer.byteLength(recipe.importText),
    contentHash: await computeStringHash(recipe.importText), sourceHash: sha256(recipe.importText),
  });
  return {
    path, recipeIndex: index, variant, bytes: Buffer.byteLength(recipe.text),
    sourceHash: sha256(recipe.text), merkleHash: await computeStringHash(recipe.text),
    declarations, imports: [{ moduleSpecifier: recipe.moduleSpecifier, startLine: 1, endLine: 1,
      startByte: 0, endByte: Buffer.byteLength(recipe.importText), sourceHash: sha256(recipe.importText) }],
    legacyRows, structuredRows,
  };
}
