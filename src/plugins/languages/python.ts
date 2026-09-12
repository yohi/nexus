import type { FileToChunk, LanguagePlugin, ParsedDeclaration, ParsedSourceFile } from '../../types/index.js';
import type { StructuredLanguageParser, StructuredSource } from '../../structured/contracts.js';
import { decodeUtf8 } from '../../structured/hash.js';
import { fixedLineFallback } from './python-legacy.js';
import { PythonStructuredParser } from './python-structured.js';
import type { PythonTreeSitterRuntime } from './python-structured.js';

const textEncoder = new TextEncoder();
const warnFallback = (error: Error): void => console.warn('python-structured-parser.fallback', error);

const sourceFor = (file: FileToChunk): StructuredSource => ({
  filePath: file.filePath,
  language: file.language,
  bytes: file.bytes ?? textEncoder.encode(file.content),
  text: file.content,
});

const loadTreeSitter = async (): Promise<PythonTreeSitterRuntime> => {
  const [parser, python] = await Promise.all([import('tree-sitter'), import('tree-sitter-python')]);
  return { Parser: parser.default, Python: python.default };
};

const projectLegacyResult = (result: Awaited<ReturnType<StructuredLanguageParser['parseStructured']>>, source: StructuredSource): ParsedSourceFile => {
  const declarations = result.declarations.map(({ kind, name, position, rawSource }): ParsedDeclaration => ({
    type: kind, name, startLine: position.startLine, endLine: position.endLine, content: rawSource ?? '',
  }));
  const ranges = [...new Map(result.imports.map((item) => [`${item.startByte}:${item.endByte}`, item])).values()]
    .toSorted((left, right) => left.startByte - right.startByte);
  const first = ranges[0];
  const last = ranges.at(-1);
  if (first && last) {
    declarations.push({
      type: 'import', name: 'imports', startLine: first.position.startLine, endLine: last.position.endLine,
      content: decodeUtf8(source.bytes.subarray(first.startByte, last.endByte)),
    });
  }
  return {
    rootType: 'module',
    declarations: declarations.toSorted((left, right) => left.startLine - right.startLine),
  };
};

export class PythonLanguagePlugin implements LanguagePlugin {
  readonly languageId = 'python';

  readonly fileExtensions = ['.py', '.pyi'];

  supports(filePath: string): boolean {
    return this.fileExtensions.some((extension) => filePath.endsWith(extension));
  }

  async createStructuredParser(): Promise<StructuredLanguageParser> {
    return new PythonStructuredParser(await loadTreeSitter());
  }

  async createParser(): Promise<{ parse(file: FileToChunk): Promise<ParsedSourceFile> }> {
    try {
      const structured = await this.createStructuredParser();
      return {
        parse: async (file) => {
          try {
            const source = sourceFor(file);
            return projectLegacyResult(await structured.parseStructured(source), source);
          } catch (error) {
            if (error instanceof Error) {
              warnFallback(error);
              return fixedLineFallback(file);
            }
            throw error;
          }
        },
      };
    } catch (error) {
      if (error instanceof Error) {
        warnFallback(error);
        return { parse: async (file) => fixedLineFallback(file) };
      }
      throw error;
    }
  }
}
