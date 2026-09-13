import type C from 'tree-sitter-c';

import { declarationsFor } from './c-structured-declarations.js';
import { importsFor } from './c-structured-imports.js';
import {
  createTreeSitterStructuredParserClass,
  type TreeSitterRuntime,
} from './tree-sitter-structured-parser.js';

export type CTreeSitterRuntime = TreeSitterRuntime<typeof C>;

export const CStructuredParser = createTreeSitterStructuredParserClass<typeof C>({
  languageId: 'c',
  parserVersion: '0.24.1',
  emptySourceMessage: 'C structured parsing requires source bytes.',
  declarationsFor,
  importsFor,
  checkScopeNode: true,
  diagnosticFor: (node) => `${node.type}@${node.startIndex}`,
});
