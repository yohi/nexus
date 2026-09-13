import { RustStructuredParser } from './rust-structured.js';
import {
  createTreeSitterLanguagePlugin,
  loadTreeSitterLanguage,
} from './tree-sitter-language-plugin.js';

const emptyRustResult = () => ({ rootType: 'source_file', declarations: [] });
const warnRustFallback = (error: Error): void => console.warn('rust-structured-parser.fallback', error);

export const RustLanguagePlugin = createTreeSitterLanguagePlugin({
  languageId: 'rust',
  fileExtensions: ['.rs'],
  rootType: 'source_file',
  createStructuredParser: async () =>
    new RustStructuredParser(await loadTreeSitterLanguage(import('tree-sitter-rust'))),
  initializationFallback: emptyRustResult,
  parseFailureFallback: emptyRustResult,
  onInitializationFailure: warnRustFallback,
  onParseFailure: warnRustFallback,
});
