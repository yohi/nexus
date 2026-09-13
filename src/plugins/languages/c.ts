import { CStructuredParser } from './c-structured.js';
import {
  createTreeSitterLanguagePlugin,
  loadTreeSitterLanguage,
} from './tree-sitter-language-plugin.js';

export const CLanguagePlugin = createTreeSitterLanguagePlugin({
  languageId: 'c',
  fileExtensions: ['.c'],
  rootType: 'translation_unit',
  createStructuredParser: async () =>
    new CStructuredParser(await loadTreeSitterLanguage(import('tree-sitter-c'))),
});
