import { createHash } from 'node:crypto';
import { computeStringHash } from '../../../src/indexer/hash.js';
import type { FixtureFile, ExpectedRow } from './contracts.js';

export const sha256 = (content: string | Uint8Array): string => createHash('sha256').update(content).digest('hex');
const padded = (index: number): string => String(index).padStart(5, '0');
export const fixturePath = (index: number): string =>
  `packages/package-${padded(Math.floor(index / 20))}/src/file-${padded(index)}.ts`;

export function createRecipe(index: number, fileCount: number, declarationsPerFile: number,
  variant: 'initial' | 'modified' = 'initial') {
  const moduleSpecifier = `./file-${padded(Math.floor(index / 20) * 20)}.js`;
  const importText = `import '${moduleSpecifier}';`;
  let text = `${importText}\n`;
  const drafts: { readonly name: string; readonly start: number; readonly end: number;
    readonly fullStart: number; readonly content: string }[] = [];
  let previousEnd = importText.length;
  for (let marker = index; marker < 125; marker += fileCount) {
    text += `// perf_hybrid_125 marker-${marker}\n`;
  }
  text += '// perf_early\n';
  for (let declaration = 0; declaration < declarationsPerFile; declaration += 1) {
    text += '\n// perf_broad\n// perf_broad\n';
    const helper = declaration === declarationsPerFile - 1;
    const name = helper ? 'sharedHelper' : `case${padded(index)}_${declaration}`;
    const value = helper ? 'shared 日本語' : `${name}-${variant}`;
    const content = `export function ${name}(): string {\n  return '${value}';\n}`;
    const start = text.length;
    text += `${content}\n`;
    drafts.push({ name, start, end: start + content.length, fullStart: previousEnd, content });
    previousEnd = start + content.length;
  }
  text += '// perf_late\n';
  return { text, importText, moduleSpecifier, drafts };
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
