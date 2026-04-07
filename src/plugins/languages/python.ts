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

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]?.trim() ?? '';
      if (line.startsWith('import ') || line.startsWith('from ')) {
        const startLine = i;
        const currentImportLines: number[] = [];

        // Continue collecting imports as long as they are contiguous or part of a parenthesized block
        while (i < lines.length) {
          const currentLine = lines[i]?.trim() ?? '';
          if (currentLine.startsWith('import ') || currentLine.startsWith('from ')) {
            currentImportLines.push(i);
            if (currentLine.includes('(')) {
              while (i + 1 < lines.length && !(lines[i + 1]?.trim() ?? '').startsWith(')')) {
                i += 1;
                currentImportLines.push(i);
              }
              if (i + 1 < lines.length) {
                i += 1;
                currentImportLines.push(i);
              }
            }
          } else if (currentLine === '') {
            // Skip empty lines within an import block if needed, 
            // but for now we follow the suggestion of contiguous imports.
            break;
          } else {
            break;
          }
          
          // Peek at the next line to see if it's still an import
          const nextLine = lines[i + 1]?.trim() ?? '';
          if (nextLine.startsWith('import ') || nextLine.startsWith('from ')) {
            i += 1;
          } else {
            break;
          }
        }

        if (currentImportLines.length > 0) {
          declarations.push({
            type: 'import',
            name: 'imports',
            startLine: startLine + 1,
            endLine: i + 1,
            content: currentImportLines.map((index) => lines[index]?.trim() ?? '').join('\n'),
          });
        }
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
