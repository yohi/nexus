import { createSymbolId } from '../../../src/structured/identity.js';
import type { FixtureManifest, QueryCase } from './contracts.js';
import { expectedSymbolId } from './audit-manifest.js';

export function findFixtureSymbol(manifest: FixtureManifest, symbolId: string) {
  for (const file of manifest.files) {
    for (const declaration of file.declarations) {
      const canonicalId = createSymbolId({ filePath: file.path, qualifiedName: declaration.name,
        kind: 'function', signatureDiscriminator: declaration.signature, occurrence: 0 });
      const nativeId = expectedSymbolId(file, declaration.name);
      if (nativeId !== undefined && (symbolId === canonicalId || symbolId === nativeId)) {
        return { file, declaration, nativeId };
      }
    }
  }
  return undefined;
}

export function executableQueryCase(query: QueryCase, manifest: FixtureManifest): QueryCase {
  switch (query.tool) {
    case 'get_symbol_source': case 'get_symbol_context': {
      const symbolId = query.args.symbolId;
      const symbol = typeof symbolId === 'string' ? findFixtureSymbol(manifest, symbolId) : undefined;
      return symbol === undefined ? query : { ...query, args: { ...query.args, symbolId: symbol.nativeId } };
    }
    case 'get_file_outline': case 'grep_search': case 'semantic_search': case 'hybrid_search': return query;
  }
}
