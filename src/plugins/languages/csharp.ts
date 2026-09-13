import { CSharpStructuredParser } from './csharp-structured.js';
import {
  createTreeSitterLanguagePlugin,
  loadTreeSitterLanguage,
} from './tree-sitter-language-plugin.js';

export const CSharpLanguagePlugin = createTreeSitterLanguagePlugin({
  languageId: 'csharp',
  fileExtensions: ['.cs'],
  rootType: 'compilation_unit',
  createStructuredParser: async () => new CSharpStructuredParser(
    await loadTreeSitterLanguage(import('tree-sitter-c-sharp/bindings/node/index.js')),
  ),
});
