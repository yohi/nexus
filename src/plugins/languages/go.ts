import type { FileToChunk, LanguagePlugin, ParsedDeclaration, ParsedSourceFile } from '../../types/index.js';

/**
 * Builds a Go declaration by scanning lines until the braces are balanced.
 * Handles block comments, raw strings, and regular strings.
 * If the starting line doesn't contain an opening brace, it treats it as a single-line declaration.
 */
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
    const line = lines[i];
    if (line === undefined) continue;
    let stripped = '';
    
    // Process character by character to handle multi-line comments and strings correctly
    for (let j = 0; j < line.length; j += 1) {
      if (inBlockComment) {
        if (line.charAt(j) === '*' && line.charAt(j + 1) === '/') {
          inBlockComment = false;
          j += 1;
        }
        continue;
      }

      if (inRawString) {
        if (line.charAt(j) === '`') {
          inRawString = false;
        }
        continue;
      }

      const char = line.charAt(j);
      const nextChar = line.charAt(j + 1);

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
        while (j < line.length && line.charAt(j) !== quote) {
          if (line.charAt(j) === '\\') j += 1; // skip escaped
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

    // If we've seen an opening brace, wait for balance.
    // If it's the first line and there's NO opening brace, it's likely a type alias or simple decl.
    if (i === startIndex && !seenOpeningBrace) {
      break;
    }

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
      const line = lines[i];
      if (line === undefined) continue;
      const trimmedLine = line.trim();

      if (trimmedLine === '') continue;

      // Handle imports
      if (trimmedLine === 'import (' || /^import\s+/.test(trimmedLine)) {
        let endIndex = i;
        if (trimmedLine === 'import (') {
          while (endIndex < lines.length) {
            const currentLine = lines[endIndex];
            if (currentLine !== undefined && currentLine.trim() === ')') {
              break;
            }
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

      // Handle grouped type declarations: type (...)
      if (trimmedLine === 'type (') {
        const startLine = i;
        let endIndex = i;
        while (endIndex < lines.length) {
          const currentLine = lines[endIndex];
          if (currentLine !== undefined && currentLine.trim() === ')') {
            break;
          }
          endIndex += 1;
        }

        // Extract individual types within the block for better indexing
        for (let j = startLine + 1; j < endIndex; j += 1) {
          const currentLine = lines[j];
          if (currentLine === undefined) continue;
          const innerLine = currentLine.trim();
          
          // Pattern for identifiers in type blocks
          const innerTypeMatch = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\s+(?:struct|interface|func|map|chan|\[\]|[A-Za-z_][A-Za-z0-9_]*)?/.exec(innerLine);
          const typeName = innerTypeMatch?.[1];
          if (typeName) {
            const decl = buildGoDeclaration(lines, j, 'class', typeName);
            declarations.push(decl);
            j = decl.endLine - 1;
          }
        }
        
        i = endIndex;
        continue;
      }

      // Handle single type declarations
      const typeMatch = /^type\s+([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\s+(?:struct|interface|[A-Za-z_][A-Za-z0-9_]*)\b/.exec(trimmedLine);
      const typeName = typeMatch?.[1];
      if (typeName) {
        const decl = buildGoDeclaration(lines, i, 'class', typeName);
        declarations.push(decl);
        i = decl.endLine - 1;
        continue;
      }

      // Handle Methods
      const methodMatch = /^func\s*\([^)]*\)\s*([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\s*\(/.exec(trimmedLine);
      const methodName = methodMatch?.[1];
      if (methodName) {
        const decl = buildGoDeclaration(lines, i, 'method', methodName);
        declarations.push(decl);
        i = decl.endLine - 1;
        continue;
      }

      // Handle Functions
      const functionMatch = /^func\s+([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\s*\(/.exec(trimmedLine);
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
