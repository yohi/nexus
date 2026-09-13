import { CppStructuredParser } from './cpp-structured.js';
import {
  createTreeSitterLanguagePlugin,
  loadTreeSitterLanguage,
} from './tree-sitter-language-plugin.js';

export const CppLanguagePlugin = createTreeSitterLanguagePlugin({
  languageId: 'cpp',
  fileExtensions: ['.h', '.cc', '.cpp', '.cxx', '.hh', '.hpp', '.hxx'],
  rootType: 'translation_unit',
  createStructuredParser: async () =>
    new CppStructuredParser(await loadTreeSitterLanguage(import('tree-sitter-cpp'))),
});
