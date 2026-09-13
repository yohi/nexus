import type CSharp from 'tree-sitter-c-sharp/bindings/node/index.js';

import { declarationsFor } from './csharp-structured-declarations.js';
import { importsFor } from './csharp-structured-imports.js';
import {
  createTreeSitterStructuredParserClass,
  type TreeSitterRuntime,
} from './tree-sitter-structured-parser.js';
import { signatureFor } from './tree-sitter-structured-support.js';

export type CSharpTreeSitterRuntime = TreeSitterRuntime<typeof CSharp>;

export const CSharpStructuredParser = createTreeSitterStructuredParserClass<typeof CSharp>({
  languageId: 'csharp',
  parserVersion: '0.23.5',
  emptySourceMessage: 'C# structured parsing requires source bytes.',
  declarationsFor,
  importsFor,
  checkScopeNode: true,
  signatureFor: (source, node) => {
    if (node.type === 'property_declaration') return node.text.replace(/\s+/gu, ' ').trim();
    return signatureFor(source, node);
  },
});
