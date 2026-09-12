import type { FileToChunk, LanguagePlugin, ParsedDeclaration, ParsedSourceFile } from '../../types/index.js';
import type { StructuredLanguageParser, StructuredSource } from '../../structured/contracts.js';
import { decodeUtf8 } from '../../structured/hash.js';
import { CppStructuredParser, type CppTreeSitterRuntime } from './cpp-structured.js';

const textEncoder = new TextEncoder();

const sourceFor = (file: FileToChunk): StructuredSource => ({
  filePath: file.filePath,
  language: file.language,
  bytes: file.bytes ?? textEncoder.encode(file.content),
  text: file.content,
});

const loadTreeSitter = async (): Promise<CppTreeSitterRuntime> => {
  const [parser, cpp] = await Promise.all([import('tree-sitter'), import('tree-sitter-cpp')]);
  return { Parser: parser.default, Cpp: cpp.default };
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
    rootType: 'translation_unit',
    declarations: declarations.toSorted((left, right) => left.startLine - right.startLine),
  };
};

export class CppLanguagePlugin implements LanguagePlugin {
  readonly languageId = 'cpp';
  readonly fileExtensions = ['.h', '.cc', '.cpp', '.cxx', '.hh', '.hpp', '.hxx'];

  supports(filePath: string): boolean {
    return this.fileExtensions.some((extension) => filePath.endsWith(extension));
  }

  async createStructuredParser(): Promise<StructuredLanguageParser> {
    return new CppStructuredParser(await loadTreeSitter());
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
