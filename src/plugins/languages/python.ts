import type { FileToChunk, LanguagePlugin, ParsedDeclaration, ParsedSourceFile } from '../../types/index.js';

const leadingSpaces = (line: string): number => line.match(/^\s*/)?.[0].length ?? 0;

const buildDeclaration = (
  lines: string[],
  startIndex: number,
  type: ParsedDeclaration['type'],
  name: string,
): ParsedDeclaration => {
  const baseIndent = leadingSpaces(lines[startIndex] ?? '');
  let endIndex = startIndex;

  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      continue;
    }

    if (leadingSpaces(line) <= baseIndent) {
      break;
    }

    endIndex = i;
  }

  return {
    type,
    name,
    startLine: startIndex + 1,
    endLine: endIndex + 1,
    content: lines.slice(startIndex, endIndex + 1).join('\n').trim(),
  };
};

class PythonParser {
  async parse(file: FileToChunk): Promise<ParsedSourceFile> {
    const lines = file.content.split('\n');
    const declarations: ParsedDeclaration[] = [];
    const importLines: number[] = [];

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]?.trim() ?? '';
      if (line.startsWith('import ') || line.startsWith('from ')) {
        importLines.push(i);
        continue;
      }

      const classMatch = /^class\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
      const className = classMatch?.[1];
      if (className) {
        declarations.push(buildDeclaration(lines, i, 'class', className));
        continue;
      }

      const functionMatch = /^def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
      const functionName = functionMatch?.[1];
      if (functionName) {
        const type = leadingSpaces(lines[i] ?? '') > 0 ? 'method' : 'function';
        declarations.push(buildDeclaration(lines, i, type, functionName));
      }
    }

    if (importLines.length > 0) {
      const firstImport = importLines[0];
      const lastImport = importLines[importLines.length - 1];

      if (firstImport === undefined || lastImport === undefined) {
        throw new Error('importLines should not be empty');
      }

      declarations.push({
        type: 'import',
        name: 'imports',
        startLine: firstImport + 1,
        endLine: lastImport + 1,
        content: importLines.map((index) => lines[index]?.trim() ?? '').join('\n'),
      });
    }

    declarations.sort((left, right) => left.startLine - right.startLine);

    return {
      rootType: 'module',
      declarations,
    };
  }
}

export class PythonLanguagePlugin implements LanguagePlugin {
  readonly languageId = 'python';

  readonly fileExtensions = ['.py'];

  supports(filePath: string): boolean {
    return this.fileExtensions.some((extension) => filePath.endsWith(extension));
  }

  async createParser(): Promise<PythonParser> {
    return new PythonParser();
  }
}
