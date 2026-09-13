import type Java from 'tree-sitter-java';

import { declarationsFor } from './java-structured-declarations.js';
import { importsFor } from './java-structured-imports.js';
import {
  createTreeSitterStructuredParserClass,
  type TreeSitterRuntime,
} from './tree-sitter-structured-parser.js';

export type JavaTreeSitterRuntime = TreeSitterRuntime<typeof Java>;

export const JavaStructuredParser = createTreeSitterStructuredParserClass<typeof Java>({
  languageId: 'java',
  parserVersion: '0.23.5',
  emptySourceMessage: 'Java structured parsing requires source bytes.',
  declarationsFor,
  importsFor,
  checkScopeNode: true,
});
