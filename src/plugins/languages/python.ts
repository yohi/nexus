import type { FileToChunk, LanguagePlugin, ParsedDeclaration, ParsedSourceFile } from '../../types/index.js';

const leadingSpaces = (line: string): number => line.match(/^\s*/)?.[0].length ?? 0;

const stripCommentsAndStrings = (line: string): string => {
  let result = '';
  let inString: string | null = null;
  let escaped = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (char === '\\') {
        escaped = true;
      } else if (char === inString) {
        inString = null;
      }
      continue;
    }
    if (char === '#' && !inString) break;
    if (char === '"' || char === "'") {
      inString = char;
      continue;
    }
    result += char;
  }
  return result;
};

const buildDeclaration = (
  lines: string[],
  startIndex: number,
  type: ParsedDeclaration['type'],
  name: string,
): ParsedDeclaration => {
  const startLineContent = lines[startIndex];
  const baseIndent = leadingSpaces(startLineContent);
  let endIndex = startIndex;
  let balance = 0;

  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i];
    const stripped = stripCommentsAndStrings(line);

    balance += (stripped.match(/\(/g) ?? []).length - (stripped.match(/\)/g) ?? []).length;
    balance += (stripped.match(/\[/g) ?? []).length - (stripped.match(/\]/g) ?? []).length;
    balance += (stripped.match(/\{/g) ?? []).length - (stripped.match(/\}/g) ?? []).length;

    if (i === startIndex) continue;
    if (line.trim() === '') continue;

    if (balance === 0 && leadingSpaces(line) <= baseIndent) {
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
  private findDecoratorStartIndex(lines: string[], index: number, indent: number): number {
    let actualStartIndex = index;
    for (let j = index - 1; j >= 0; j -= 1) {
      const prevLine = lines[j];
      const prevLineTrimmed = prevLine.trim();
      if (prevLineTrimmed === '') break;
      if (leadingSpaces(prevLine) === indent && prevLineTrimmed.startsWith('@')) {
        actualStartIndex = j;
      } else {
        break;
      }
    }
    return actualStartIndex;
  }

  parse(file: FileToChunk): Promise<ParsedSourceFile> {
    const lines = file.content.split('\n');
    const declarations: ParsedDeclaration[] = [];

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const trimmedLine = line.trim();

      if (trimmedLine.startsWith('import ') || trimmedLine.startsWith('from ')) {
        const startLine = i;
        const currentImportLines: number[] = [];

        while (i < lines.length) {
          const currentLine = lines[i];
          const currentLineTrimmed = currentLine.trim();

          if (currentLineTrimmed.startsWith('import ') || currentLineTrimmed.startsWith('from ')) {
            currentImportLines.push(i);
            let braceBalance = (currentLineTrimmed.match(/\(/g) ?? []).length - (currentLineTrimmed.match(/\)/g) ?? []).length;
            let hasBackslash = currentLineTrimmed.endsWith('\\');

            while ((braceBalance > 0 || hasBackslash) && i + 1 < lines.length) {
              i += 1;
              const nextLine = lines[i];
              const nextLineTrimmed = nextLine.trim();
              currentImportLines.push(i);
              braceBalance += (nextLineTrimmed.match(/\(/g) ?? []).length - (nextLineTrimmed.match(/\)/g) ?? []).length;
              hasBackslash = nextLineTrimmed.endsWith('\\');
            }
          } else if (currentLineTrimmed === '') {
            break;
          } else {
            break;
          }
          
          const nextLineIdx = i + 1;
          const nextLine = lines[nextLineIdx];
          if (typeof nextLine === 'string' && (nextLine.trim().startsWith('import ') || nextLine.trim().startsWith('from '))) {
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

      const classMatch = /^class\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(trimmedLine);
      const className = classMatch?.[1];
      if (className) {
        const currentIndent = leadingSpaces(line);
        const actualStartIndex = this.findDecoratorStartIndex(lines, i, currentIndent);
        const decl = buildDeclaration(lines, actualStartIndex, 'class', className);
        declarations.push(decl);
        // Do NOT skip the body to allow method extraction
        continue;
      }

      const functionMatch = /^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(trimmedLine);
      const functionName = functionMatch?.[1];
      if (functionName) {
        const currentIndent = leadingSpaces(line);
        let isMethod = false;

        if (currentIndent > 0) {
          let checkIndent = currentIndent;
          for (let j = i - 1; j >= 0; j -= 1) {
            const prevLine = lines[j];
            const prevLineTrimmed = prevLine.trim();
            if (prevLineTrimmed === '') continue;

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

        const actualStartIndex = this.findDecoratorStartIndex(lines, i, currentIndent);
        const type = isMethod ? 'method' : 'function';
        const decl = buildDeclaration(lines, actualStartIndex, type, functionName);
        declarations.push(decl);
        
        // If it's a regular function (not a method inside a class), skip its body 
        // to avoid redundant scanning and extraction of inner functions as top-level items.
        if (!isMethod) {
          i = decl.endLine - 1;
        }
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
