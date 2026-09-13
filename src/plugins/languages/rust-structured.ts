import type Rust from 'tree-sitter-rust';

import { declarationsFor } from './rust-structured-declarations.js';
import { importsFor } from './rust-structured-imports.js';
import { declarationStartByteFor } from './rust-structured-support.js';
import {
  createTreeSitterStructuredParserClass,
  type TreeSitterRuntime,
} from './tree-sitter-structured-parser.js';

export type RustTreeSitterRuntime = TreeSitterRuntime<typeof Rust>;

export const RustStructuredParser = createTreeSitterStructuredParserClass<typeof Rust>({
  languageId: 'rust',
  parserVersion: '0.24.0',
  emptySourceMessage: 'Rust structured parsing requires original source bytes.',
  declarationsFor,
  importsFor,
  startByteFor: declarationStartByteFor,
});
