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

  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;

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

      if (/^import\b/.test(line)) {
        let endIndex = i;
        const nextChar = line.slice(6).trim()[0];
        if (nextChar === '(' || line === 'import (') {
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
        declarations.push(buildGoDeclaration(lines, i, 'class', typeName));
        continue;
      }

      const methodMatch = /^func\s*\([^)]*\)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
      const methodName = methodMatch?.[1];
      if (methodName) {
        declarations.push(buildGoDeclaration(lines, i, 'method', methodName));
        continue;
      }

      const functionMatch = /^func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
      const functionName = functionMatch?.[1];
      if (functionName) {
        declarations.push(buildGoDeclaration(lines, i, 'function', functionName));
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
