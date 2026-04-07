import type { FileToChunk, LanguagePlugin, ParsedDeclaration, ParsedSourceFile } from '../../types/index.js';

const leadingSpaces = (line: string): number => line.match(/^\s*/)?.[0].length ?? 0;

interface StripperState {
  inString: string | null;
  escaped: boolean;
}

/**
 * Strips comments and strings from a line of Python code to help with balance tracking.
 * Handles single quotes, double quotes, and triple quotes while maintaining state across lines.
 */
const stripCommentsAndStrings = (line: string, state: StripperState): { stripped: string; state: StripperState } => {
  let result = '';
  let i = 0;
  let { inString, escaped } = state;

  while (i < line.length) {
    const char = line[i]!;

    if (escaped) {
      escaped = false;
      i += 1;
      continue;
    }

    if (inString) {
      if (char === '\\') {
        escaped = true;
        i += 1;
      } else if (line.startsWith(inString, i)) {
        i += inString.length;
        inString = null;
      } else {
        i += 1;
      }
      continue;
    }

    // Check for triple quotes first
    if (line.startsWith('"""', i)) {
      inString = '"""';
      i += 3;
      continue;
    }
    if (line.startsWith("'''", i)) {
      inString = "'''";
      i += 3;
      continue;
    }

    // Check for single quotes
    if (char === '"' || char === "'") {
      inString = char;
      i += 1;
      continue;
    }

    // Check for comments
    if (char === '#') {
      break;
    }

    result += char;
    i += 1;
  }
  return { stripped: result, state: { inString, escaped } };
};

/**
 * Builds a declaration by scanning lines until the end of the block.
 * Uses indentation and parenthesis/bracket balance to determine the boundary.
 */
const buildDeclaration = (
  lines: string[],
  startIndex: number,
  headerIndex: number,
  type: ParsedDeclaration['type'],
  name: string,
): ParsedDeclaration => {
  const headerLine = lines[headerIndex];
  const headerIndent = headerLine ? leadingSpaces(headerLine) : 0;
  let endIndex = headerIndex;
  let balance = 0;
  let headerFinished = false;
  let stripperState: StripperState = { inString: null, escaped: false };

  for (let i = headerIndex; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;

    const { stripped, state } = stripCommentsAndStrings(line, stripperState);
    stripperState = state;

    balance += (stripped.match(/\(/g) ?? []).length - (stripped.match(/\)/g) ?? []).length;
    balance += (stripped.match(/\[/g) ?? []).length - (stripped.match(/\]/g) ?? []).length;
    balance += (stripped.match(/\{/g) ?? []).length - (stripped.match(/\}/g) ?? []).length;

    if (!headerFinished) {
      if (balance <= 0) {
        headerFinished = true;
      }
      endIndex = i;
      continue;
    }

    // After header is finished, we look for dedent
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }

    // If we reach a line with same or less indentation, we stop
    if (balance === 0 && stripperState.inString === null && leadingSpaces(line) <= headerIndent && i > headerIndex) {
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
  /**
   * Backtracks from a declaration line to find any preceding decorators.
   */
  private findDecoratorStartIndex(lines: string[], index: number, indent: number): number {
    let actualStartIndex = index;
    for (let j = index - 1; j >= 0; j -= 1) {
      const prevLine = lines[j];
      if (prevLine === undefined) break;

      const prevLineTrimmed = prevLine.trim();
      if (prevLineTrimmed === '') continue; // Skip blank lines between decorators
      if (leadingSpaces(prevLine) === indent && prevLineTrimmed.startsWith('@')) {
        actualStartIndex = j;
      } else if (prevLineTrimmed.startsWith('#')) {
        continue; // Skip comments
      } else {
        break;
      }
    }
    return actualStartIndex;
  }

  async parse(file: FileToChunk): Promise<ParsedSourceFile> {
    const lines = file.content.split('\n');
    const declarations: ParsedDeclaration[] = [];
    let stripperState: StripperState = { inString: null, escaped: false };

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line === undefined) continue;

      const trimmedLine = line.trim();
      if (trimmedLine === '') continue;

      // Update stripper state for each line to correctly handle context for imports/classes/defs
      const { state } = stripCommentsAndStrings(line, stripperState);
      stripperState = state;

      // Skip parsing inside multi-line strings
      if (stripperState.inString !== null) continue;

      // Handle imports
      if (trimmedLine.startsWith('import ') || trimmedLine.startsWith('from ')) {
        const startLine = i;
        const currentImportLines: number[] = [];

        while (i < lines.length) {
          const currentLine = lines[i];
          if (currentLine === undefined) break;

          const currentLineTrimmed = currentLine.trim();

          if (currentLineTrimmed.startsWith('import ') || currentLineTrimmed.startsWith('from ')) {
            currentImportLines.push(i);
            
            // Check for multi-line imports
            let innerStripperState: StripperState = { inString: null, escaped: false };
            const { stripped } = stripCommentsAndStrings(currentLineTrimmed, innerStripperState);
            let balance = (stripped.match(/\(/g) ?? []).length - (stripped.match(/\)/g) ?? []).length;
            let hasBackslash = currentLineTrimmed.endsWith('\\');

            while ((balance > 0 || hasBackslash) && i + 1 < lines.length) {
              i += 1;
              const nextLine = lines[i];
              if (nextLine === undefined) break;

              const nextLineTrimmed = nextLine.trim();
              currentImportLines.push(i);
              const { stripped: nextStripped } = stripCommentsAndStrings(nextLineTrimmed, innerStripperState);
              balance += (nextStripped.match(/\(/g) ?? []).length - (nextStripped.match(/\)/g) ?? []).length;
              hasBackslash = nextLineTrimmed.endsWith('\\');
            }
          } else if (currentLineTrimmed === '') {
            // Skip empty lines
          } else {
            break;
          }
          
          if (i + 1 < lines.length) {
            const nextLine = lines[i + 1];
            if (nextLine === undefined) break;

            const nextLineTrimmed = nextLine.trim();
            if (nextLineTrimmed.startsWith('import ') || nextLineTrimmed.startsWith('from ') || nextLineTrimmed === '') {
              i += 1;
            } else {
              break;
            }
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
            content: currentImportLines.map((idx) => lines[idx] ?? '').join('\n').trim(),
          });
        }
        continue;
      }

      // Handle Classes
      const classMatch = /^class\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(trimmedLine);
      if (classMatch) {
        const className = classMatch[1]!;
        const currentIndent = leadingSpaces(line);
        // Only collect top-level classes as explicit declarations.
        // We still allow the loop to continue to scan the body for methods.
        if (currentIndent === 0) {
          const startIndex = this.findDecoratorStartIndex(lines, i, currentIndent);
          const decl = buildDeclaration(lines, startIndex, i, 'class', className);
          declarations.push(decl);
        }
        continue;
      }

      // Handle Functions and Methods
      // Updated regex to support PEP 695 generics (e.g. def foo[T](...):)
      const functionMatch = /^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*\[[^\]]+\])?\s*\(/.exec(trimmedLine);
      if (functionMatch) {
        const functionName = functionMatch[1]!;
        const currentIndent = leadingSpaces(line);
        
        let isMethod = false;
        if (currentIndent > 0) {
          let checkIndent = currentIndent;
          for (let j = i - 1; j >= 0; j -= 1) {
            const prevLine = lines[j];
            if (prevLine === undefined) break;

            const prevLineTrimmed = prevLine.trim();
            if (prevLineTrimmed === '' || prevLineTrimmed.startsWith('#')) continue;

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

        const startIndex = this.findDecoratorStartIndex(lines, i, currentIndent);
        const type = isMethod ? 'method' : 'function';
        const decl = buildDeclaration(lines, startIndex, i, type, functionName);
        declarations.push(decl);
        
        // Always advance the loop index to the end of the declaration body
        // to avoid re-scanning and collecting inner declarations (like nested defs or imports).
        i = decl.endLine - 1;
        continue;
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

  async createParser(): Promise<{ parse(file: FileToChunk): Promise<ParsedSourceFile> }> {
    return new PythonParser();
  }
}
