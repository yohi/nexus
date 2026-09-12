import type { FileToChunk, LanguagePlugin, ParsedDeclaration, ParsedSourceFile } from '../../types/index.js';
import type { StructuredLanguageParser, StructuredSource } from '../../structured/contracts.js';
import { decodeUtf8 } from '../../structured/hash.js';
import { CSharpStructuredParser, type CSharpTreeSitterRuntime } from './csharp-structured.js';

const textEncoder = new TextEncoder();

const sourceFor = (file: FileToChunk): StructuredSource => ({
  filePath: file.filePath,
  language: file.language,
  bytes: file.bytes ?? textEncoder.encode(file.content),
  text: file.content,
});

const loadTreeSitter = async (): Promise<CSharpTreeSitterRuntime> => {
  const [parser, csharp] = await Promise.all([
    import('tree-sitter'),
    import('tree-sitter-c-sharp/bindings/node/index.js'),
  ]);
  return { Parser: parser.default, CSharp: csharp.default };
};

const projectLegacyResult = (
  result: Extract<Awaited<ReturnType<StructuredLanguageParser['parseStructured']>>, { status: 'ok' | 'degraded' }>,
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
    rootType: 'compilation_unit',
    declarations: declarations.toSorted((left, right) => left.startLine - right.startLine),
  };
};

export class CSharpLanguagePlugin implements LanguagePlugin {
  readonly languageId = 'csharp';
  readonly fileExtensions = ['.cs'];

  supports(filePath: string): boolean {
    return this.fileExtensions.some((extension) => filePath.endsWith(extension));
  }

  async createStructuredParser(): Promise<StructuredLanguageParser> {
    return new CSharpStructuredParser(await loadTreeSitter());
  }

  async createParser(): Promise<{ parse(file: FileToChunk): Promise<ParsedSourceFile> }> {
    const structured = await this.createStructuredParser();
    return {
      parse: async (file) => {
        const source = sourceFor(file);
        const result = await structured.parseStructured(source);
        if (result.status !== 'ok' && result.status !== 'degraded') throw new Error(result.failure.message);
        return projectLegacyResult(result, source);
      },
    };
  }
}
