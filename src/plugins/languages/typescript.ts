import type { FileToChunk, LanguagePlugin, ParsedDeclaration, ParsedSourceFile } from '../../types/index.js';

const getLineRange = (source: string, startOffset: number, endOffset: number): { startLine: number; endLine: number } => {
  const startLine = source.slice(0, startOffset).split('\n').length;
  const endLine = source.slice(0, endOffset).split('\n').length;
  return { startLine, endLine };
};

const matchAll = (pattern: RegExp, source: string): ParsedDeclaration[] => {
  const declarations: ParsedDeclaration[] = [];

  for (const match of source.matchAll(pattern)) {
    const fullMatch = match[0];
    const name = match[1] ?? 'anonymous';
    const start = match.index ?? 0;
    const end = start + fullMatch.length;
    const { startLine, endLine } = getLineRange(source, start, end);
    declarations.push({
      type: pattern === IMPORT_PATTERN ? 'import' : pattern === INTERFACE_PATTERN ? 'interface' : pattern === FUNCTION_PATTERN ? 'function' : pattern === CLASS_PATTERN ? 'class' : 'method',
      name,
      startLine,
      endLine,
      content: fullMatch.trim(),
    });
  }

  return declarations;
};

const IMPORT_PATTERN = /^import\s+[\s\S]*?from\s+['"][^'"]+['"];?$/gm;
const INTERFACE_PATTERN = /^export\s+interface\s+(\w+)\s*\{[\s\S]*?^\}/gm;
const FUNCTION_PATTERN = /\/\*\*[\s\S]*?\*\/\s*export\s+async\s+function\s+(\w+)\s*\([^)]*\)\s*:\s*Promise<[^>]+>\s*\{[\s\S]*?^\}/gm;
const CLASS_PATTERN = /^export\s+class\s+(\w+)\s*\{[\s\S]*?^\}/gm;
const METHOD_PATTERN = /^\s{2}(?:async\s+)?(\w+)\([^)]*\):\s*[^\{]+\{[\s\S]*?^\s{2}\}\n?/gm;

class TypeScriptParser {
  async parse(file: FileToChunk): Promise<ParsedSourceFile> {
    const declarations: ParsedDeclaration[] = [];
    const imports = matchAll(IMPORT_PATTERN, file.content);

    if (imports.length > 0) {
      const [firstImport] = imports;
      if (firstImport !== undefined) {
        declarations.push({
          type: firstImport.type,
          name: 'imports',
          startLine: firstImport.startLine,
          endLine: firstImport.endLine,
          content: firstImport.content,
        });
      }
    }

    declarations.push(...matchAll(INTERFACE_PATTERN, file.content));
    declarations.push(...matchAll(FUNCTION_PATTERN, file.content));
    declarations.push(...matchAll(CLASS_PATTERN, file.content));
    declarations.push(...matchAll(METHOD_PATTERN, file.content));

    declarations.sort((left, right) => left.startLine - right.startLine);

    return {
      rootType: 'program',
      declarations,
    };
  }
}

export class TypeScriptLanguagePlugin implements LanguagePlugin {
  readonly languageId = 'typescript';

  readonly fileExtensions = ['.ts', '.tsx', '.js', '.jsx'];

  supports(filePath: string): boolean {
    return this.fileExtensions.some((extension) => filePath.endsWith(extension));
  }

  async createParser(): Promise<TypeScriptParser> {
    return new TypeScriptParser();
  }
}
