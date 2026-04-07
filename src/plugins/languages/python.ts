import type { FileToChunk, LanguagePlugin, ParsedDeclaration, ParsedSourceFile } from '../../types/index.js';

const leadingSpaces = (line: string): number => line.match(/^\s*/)?.[0].length ?? 0;

const buildDeclaration = (
  lines: string[],
  startIndex: number,
  type: ParsedDeclaration['type'],
  name: string,
): ParsedDeclaration => {
  const startLineContent = lines[startIndex];
  if (typeof startLineContent !== 'string') {
    throw new Error('Invalid start index for declaration');
  }
  const baseIndent = leadingSpaces(startLineContent);
  let endIndex = startIndex;
  let balance = 0;

  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i];
    if (typeof line !== 'string') continue;

    // Update balance based on brackets in the current line
    balance += (line.match(/\(/g) ?? []).length - (line.match(/\)/g) ?? []).length;
    balance += (line.match(/\[/g) ?? []).length - (line.match(/\]/g) ?? []).length;
    balance += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;

    if (i === startIndex) continue;

    if (line.trim() === '') {
      continue;
    }

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
  parse(file: FileToChunk): Promise<ParsedSourceFile> {
    const lines = file.content.split('\n');
    const declarations: ParsedDeclaration[] = [];

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (typeof line !== 'string') continue;
      const trimmedLine = line.trim();

      if (trimmedLine.startsWith('import ') || trimmedLine.startsWith('from ')) {
        const startLine = i;
        const currentImportLines: number[] = [];

        // Continue collecting imports as long as they are contiguous or part of a parenthesized block
        while (i < lines.length) {
          const currentLine = lines[i];
          if (typeof currentLine !== 'string') break;
          const currentLineTrimmed = currentLine.trim();

          if (currentLineTrimmed.startsWith('import ') || currentLineTrimmed.startsWith('from ')) {
            currentImportLines.push(i);
            
            // Check brace balance to handle parenthesized imports across lines
            let braceBalance = (currentLineTrimmed.match(/\(/g) ?? []).length - (currentLineTrimmed.match(/\)/g) ?? []).length;
            let hasBackslash = currentLineTrimmed.endsWith('\\');

            while ((braceBalance > 0 || hasBackslash) && i + 1 < lines.length) {
              i += 1;
              const nextLine = lines[i];
              if (typeof nextLine !== 'string') break;
              const nextLineTrimmed = nextLine.trim();
              currentImportLines.push(i);
              braceBalance += (nextLineTrimmed.match(/\(/g) ?? []).length - (nextLineTrimmed.match(/\)/g) ?? []).length;
              hasBackslash = nextLineTrimmed.endsWith('\\');
            }
          } else if (currentLineTrimmed === '') {
            // Skip empty lines within an import block if needed, 
            // but for now we follow the suggestion of contiguous imports.
            break;
          } else {
            break;
          }
          
          // Peek at the next line to see if it's still an import
          const nextLine = lines[i + 1];
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
        let actualStartIndex = i;
        const currentIndent = leadingSpaces(lines[i] ?? '');
        
        // Backtrack to find decorators
        for (let j = i - 1; j >= 0; j -= 1) {
          const prevLine = lines[j];
          if (typeof prevLine !== 'string') break;
          const prevLineTrimmed = prevLine.trim();
          if (prevLineTrimmed === '') break;
          if (leadingSpaces(prevLine) === currentIndent && prevLineTrimmed.startsWith('@')) {
            actualStartIndex = j;
          } else {
            break;
          }
        }

        const decl = buildDeclaration(lines, actualStartIndex, 'class', className);
        declarations.push(decl);
        i = decl.endLine - 1;
        continue;
      }

      const functionMatch = /^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(trimmedLine);
      const functionName = functionMatch?.[1];
      if (functionName) {
        const currentLineForIndent = lines[i] ?? '';
        const currentIndent = leadingSpaces(currentLineForIndent);
        let isMethod = false;

        if (currentIndent > 0) {
          let checkIndent = currentIndent;
          for (let j = i - 1; j >= 0; j -= 1) {
            const prevLine = lines[j];
            if (typeof prevLine !== 'string') continue;
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

        let actualStartIndex = i;
        // Backtrack to find decorators
        for (let j = i - 1; j >= 0; j -= 1) {
          const prevLine = lines[j];
          if (typeof prevLine !== 'string') break;
          const prevLineTrimmed = prevLine.trim();
          if (prevLineTrimmed === '') break;
          if (leadingSpaces(prevLine) === currentIndent && prevLineTrimmed.startsWith('@')) {
            actualStartIndex = j;
          } else {
            break;
          }
        }

        const type = isMethod ? 'method' : 'function';
        declarations.push(buildDeclaration(lines, actualStartIndex, type, functionName));
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
