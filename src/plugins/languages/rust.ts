import type { FileToChunk, LanguagePlugin, ParsedDeclaration, ParsedSourceFile } from '../../types/index.js';
import type { StructuredLanguageParser, StructuredSource } from '../../structured/contracts.js';
import { decodeUtf8 } from '../../structured/hash.js';
import { RustStructuredParser, type RustTreeSitterRuntime } from './rust-structured.js';

const textEncoder = new TextEncoder();

const sourceFor = (file: FileToChunk): StructuredSource => ({
  filePath: file.filePath,
  language: file.language,
  bytes: file.bytes ?? textEncoder.encode(file.content),
  text: file.content,
});

const loadTreeSitter = async (): Promise<RustTreeSitterRuntime> => {
  const [parser, rust] = await Promise.all([import('tree-sitter'), import('tree-sitter-rust')]);
  return { Parser: parser.default, Rust: rust.default };
};

const projectLegacyResult = (
  result: Awaited<ReturnType<StructuredLanguageParser['parseStructured']>>,
  source: StructuredSource,
): ParsedSourceFile => {
  const declarations = result.declarations.map(({ kind, name, position, rawSource }): ParsedDeclaration => ({
    type: kind,
    name,
    startLine: position.startLine,
    endLine: position.endLine,
    content: rawSource ?? '',
  }));
  const ranges = [...new Map(result.imports.map((item) => [`${item.startByte}:${item.endByte}`, item])).values()]
    .toSorted((left, right) => left.startByte - right.startByte);
  for (const item of ranges) {
    declarations.push({
      type: 'import',
      name: 'imports',
      startLine: item.position.startLine,
      endLine: item.position.endLine,
      content: decodeUtf8(source.bytes.subarray(item.startByte, item.endByte)),
    });
  }
  return {
    rootType: 'source_file',
    declarations: declarations.toSorted((left, right) => left.startLine - right.startLine),
  };
};

export class RustLanguagePlugin implements LanguagePlugin {
  readonly languageId = 'rust';

  readonly fileExtensions = ['.rs'];

  supports(filePath: string): boolean {
    return this.fileExtensions.some((extension) => filePath.endsWith(extension));
  }

  async createStructuredParser(): Promise<StructuredLanguageParser> {
    const runtime = await loadTreeSitter();
    return new RustStructuredParser(runtime);
  }

  async createParser(): Promise<{ parse(file: FileToChunk): Promise<ParsedSourceFile> }> {
    try {
      const structured = await this.createStructuredParser();
      return {
        parse: async (file) => {
          try {
            const source = sourceFor(file);
            const structuredResult = await structured.parseStructured(source);
            if (structuredResult.status === 'ok' || structuredResult.status === 'degraded') {
              return projectLegacyResult(structuredResult, source);
            }
          } catch (error) {
            if (error instanceof Error) {
              console.warn('rust-structured-parser.fallback', error);
            }
            throw error;
          }
          return { rootType: 'source_file', declarations: [] };
        },
      };
    } catch (error) {
      if (error instanceof Error) {
        console.warn('rust-structured-parser.fallback', error);
        return { parse: async () => ({ rootType: 'source_file', declarations: [] }) };
      }
      throw error;
    }
  }
}
