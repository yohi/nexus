import { JavaStructuredParser } from './java-structured.js';
import {
  createTreeSitterLanguagePlugin,
  loadTreeSitterLanguage,
} from './tree-sitter-language-plugin.js';

export const JavaLanguagePlugin = createTreeSitterLanguagePlugin({
  languageId: 'java',
  fileExtensions: ['.java'],
  rootType: 'program',
  createStructuredParser: async () =>
    new JavaStructuredParser(await loadTreeSitterLanguage(import('tree-sitter-java'))),
});
