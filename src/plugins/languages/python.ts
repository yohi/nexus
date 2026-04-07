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
  parse(file: FileToChunk): Promise<ParsedSourceFile> {
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
            
            // Check brace balance to handle parenthesized imports across lines
            let braceBalance = (currentLine.match(/\(/g) ?? []).length - (currentLine.match(/\)/g) ?? []).length;
            
            while (braceBalance > 0 && i + 1 < lines.length) {
              i += 1;
              const nextLine = lines[i]?.trim() ?? '';
              currentImportLines.push(i);
              braceBalance += (nextLine.match(/\(/g) ?? []).length - (nextLine.match(/\)/g) ?? []).length;
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
        // We do not skip the class body because we want to extract inner methods
        // as separate declarations for better searchability and context.
        declarations.push(buildDeclaration(lines, i, 'class', className));
        continue;
      }

      const functionMatch = /^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
      const functionName = functionMatch?.[1];
      if (functionName) {
        const currentIndent = leadingSpaces(lines[i] ?? '');
        let isMethod = false;

        if (currentIndent > 0) {
          let checkIndent = currentIndent;
          for (let j = i - 1; j >= 0; j -= 1) {
            const prevLine = lines[j] ?? '';
            const prevLineTrimmed = prevLine.trim();
            if (prevLineTrimmed === '') {
              continue;
            }

            const prevIndent = leadingSpaces(prevLine);
            if (prevIndent < checkIndent) {
              if (prevLineTrimmed.startsWith('class ')) {
                isMethod = true;
                break;
              }
              if (prevLineTrimmed.startsWith('def ') || prevLineTrimmed.startsWith('async def ')) {
                isMethod = false;
                break;
              }
              checkIndent = prevIndent;
            }
          }
        }

        const type = isMethod ? 'method' : 'function';
        declarations.push(buildDeclaration(lines, i, type, functionName));
        continue;
      }
    }

    declarations.sort((left, right) => left.startLine - right.startLine);

    return Promise.resolve({
      rootType: 'module',
      declarations,
    });
  }
}

export class PythonLanguagePlugin implements LanguagePlugin {
  readonly languageId = 'python';

  readonly fileExtensions = ['.py'];

  supports(filePath: string): boolean {
    return this.fileExtensions.some((extension) => filePath.endsWith(extension));
  }

  createParser(): Promise<{ parse(file: FileToChunk): Promise<ParsedSourceFile> }> {
    return Promise.resolve(new PythonParser());
  }
}
