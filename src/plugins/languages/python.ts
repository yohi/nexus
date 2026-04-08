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
  let signatureClosed = false;

  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const trimmedWithComments = line.trim();
    if (trimmedWithComments === '' || trimmedWithComments.startsWith('#')) {
      if (!signatureClosed) {
        endIndex = i;
      }
      continue;
    }

    if (!signatureClosed) {
      const trimmed = line.split('#')[0]?.trim() ?? '';
      if (trimmed.endsWith(':')) {
        signatureClosed = true;
      }
      endIndex = i;
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

    for (let i = 0; i < lines.length; i += 1) {
      const fullLine = lines[i] ?? '';
      const line = fullLine.trim();
      const indent = leadingSpaces(fullLine);

      if (indent === 0 && (line.startsWith('import ') || line.startsWith('from '))) {
        const start = i;
        while (i + 1 < lines.length) {
          const nextLine = lines[i + 1] ?? '';
          const nextLineTrim = nextLine.trim();
          if (
            leadingSpaces(nextLine) === 0 &&
            (nextLineTrim.startsWith('import ') || nextLineTrim.startsWith('from '))
          ) {
            i += 1;
          } else {
            break;
          }
        }
        declarations.push({
          type: 'import',
          name: 'imports',
          startLine: start + 1,
          endLine: i + 1,
          content: lines.slice(start, i + 1).join('\n').trim(),
        });
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
