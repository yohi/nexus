import type Cpp from 'tree-sitter-cpp';

import { declarationsFor } from './cpp-structured-declarations.js';
import { importsFor } from './cpp-structured-imports.js';
import {
  createTreeSitterStructuredParserClass,
  type TreeSitterRuntime,
} from './tree-sitter-structured-parser.js';

export type CppTreeSitterRuntime = TreeSitterRuntime<typeof Cpp>;

export const CppStructuredParser = createTreeSitterStructuredParserClass<typeof Cpp>({
  languageId: 'cpp',
  parserVersion: '0.23.4',
  emptySourceMessage: 'C++ structured parsing requires source bytes.',
  declarationsFor,
  importsFor,
  checkScopeNode: true,
});
