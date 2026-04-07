import type { FileToChunk, LanguagePlugin, ParsedDeclaration, ParsedSourceFile } from '../../types/index.js';

const buildGoDeclaration = (
  lines: string[],
  startIndex: number,
  type: ParsedDeclaration['type'],
  name: string,
): ParsedDeclaration => {
  let endIndex = startIndex;
  let braceDepth = 0;
  let seenOpeningBrace = false;
  let inBlockComment = false;
  let inRawString = false;

  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    let stripped = '';
    
    // Process character by character to handle multi-line comments and strings correctly
    for (let j = 0; j < line.length; j += 1) {
      if (inBlockComment) {
        if (line[j] === '*' && line[j + 1] === '/') {
          inBlockComment = false;
          j += 1;
        }
        continue;
      }

      if (inRawString) {
        if (line[j] === '`') {
          inRawString = false;
        }
        continue;
      }

      const char = line[j];
      const nextChar = line[j + 1];

      if (char === '/' && nextChar === '*') {
        inBlockComment = true;
        j += 1;
        continue;
      }
      if (char === '/' && nextChar === '/') {
        break; // Line comment, skip rest of the line
      }
      
      // Simple string literals (single line in Go)
      if (char === '"' || char === '\'') {
        const quote = char;
        j += 1;
        while (j < line.length && line[j] !== quote) {
          if (line[j] === '\\') j += 1; // skip escaped
          j += 1;
        }
        continue;
      }
      
      // Backtick raw strings
      if (char === '`') {
        inRawString = true;
        continue;
      }

      stripped += char;
    }

    const opens = (stripped.match(/\{/g) ?? []).length;
    const closes = (stripped.match(/\}/g) ?? []).length;

    if (opens > 0) {
      seenOpeningBrace = true;
    }

    braceDepth += opens - closes;
    endIndex = i;

    if (seenOpeningBrace && braceDepth <= 0) {
      break;
    }
  }

  return {
    type,
    name,
    startLine: startIndex + 1,
    endLine: endIndex + 1,
    content: lines.slice(startIndex, endIndex + 1).join('\n').trim(),
  };
};

class GoParser {
  async parse(file: FileToChunk): Promise<ParsedSourceFile> {
    const lines = file.content.split('\n');
    const declarations: ParsedDeclaration[] = [];

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]?.trim() ?? '';

      if (line === 'import (' || /^import\s+/.test(line)) {
        let endIndex = i;
        if (line === 'import (') {
          while (endIndex < lines.length && (lines[endIndex]?.trim() ?? '') !== ')') {
            endIndex += 1;
          }
        }

        declarations.push({
          type: 'import',
          name: 'imports',
          startLine: i + 1,
          endLine: endIndex + 1,
          content: lines.slice(i, endIndex + 1).join('\n').trim(),
        });
        i = endIndex;
        continue;
      }

      const typeMatch = /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+struct\b/.exec(line);
      const typeName = typeMatch?.[1];
      if (typeName) {
        const decl = buildGoDeclaration(lines, i, 'class', typeName);
        declarations.push(decl);
        i = decl.endLine - 1;
        continue;
      }

      const methodMatch = /^func\s*\([^)]*\)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
      const methodName = methodMatch?.[1];
      if (methodName) {
        const decl = buildGoDeclaration(lines, i, 'method', methodName);
        declarations.push(decl);
        i = decl.endLine - 1;
        continue;
      }

      const functionMatch = /^func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
      const functionName = functionMatch?.[1];
      if (functionName) {
        const decl = buildGoDeclaration(lines, i, 'function', functionName);
        declarations.push(decl);
        i = decl.endLine - 1;
        continue;
      }
    }

    declarations.sort((left, right) => left.startLine - right.startLine);

    return {
      rootType: 'source_file',
      declarations,
    };
  }
}

export class GoLanguagePlugin implements LanguagePlugin {
  readonly languageId = 'go';

  readonly fileExtensions = ['.go'];

  supports(filePath: string): boolean {
    return this.fileExtensions.some((extension) => filePath.endsWith(extension));
  }

  async createParser(): Promise<GoParser> {
    return new GoParser();
  }
}
