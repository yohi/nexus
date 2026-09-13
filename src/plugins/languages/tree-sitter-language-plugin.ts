import type { StructuredLanguageParser, StructuredParseResult, StructuredSource } from '../../structured/contracts.js';
import { decodeUtf8 } from '../../structured/hash.js';
import type { FileToChunk, LanguagePlugin, ParsedDeclaration, ParsedSourceFile } from '../../types/index.js';
import type { TreeSitterRuntime } from './tree-sitter-structured-parser.js';

const textEncoder = new TextEncoder();

export interface TreeSitterLanguagePluginConfig {
  readonly languageId: string;
  readonly fileExtensions: readonly string[];
  readonly rootType: string;
  readonly createStructuredParser: () => Promise<StructuredLanguageParser>;
  readonly initializationFallback?: (file: FileToChunk) => ParsedSourceFile;
  readonly parseFailureFallback?: (file: FileToChunk) => ParsedSourceFile;
  readonly onInitializationFailure?: (error: Error) => void;
  readonly onParseFailure?: (error: Error) => void;
}

export const loadTreeSitterLanguage = async <TLanguage>(
  languageModule: Promise<{ default: TLanguage }>,
): Promise<TreeSitterRuntime<TLanguage>> => {
  const [parser, language] = await Promise.all([import('tree-sitter'), languageModule]);
  return { Parser: parser.default, language: language.default };
};

const sourceFor = (file: FileToChunk): StructuredSource => ({
  filePath: file.filePath,
  language: file.language,
  bytes: file.bytes ?? textEncoder.encode(file.content),
  text: file.content,
});

const projectLegacyResult = (
  result: Pick<StructuredParseResult, 'declarations' | 'imports'>,
  source: StructuredSource,
  rootType: string,
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
    rootType,
    declarations: declarations.toSorted((left, right) => left.startLine - right.startLine),
  };
};

export class TreeSitterLanguagePlugin implements LanguagePlugin {
  readonly languageId: string;
  readonly fileExtensions: string[];

  constructor(private readonly config: TreeSitterLanguagePluginConfig) {
    this.languageId = config.languageId;
    this.fileExtensions = [...config.fileExtensions];
  }

  supports(filePath: string): boolean {
    return this.fileExtensions.some((extension) => filePath.endsWith(extension));
  }

  createStructuredParser(): Promise<StructuredLanguageParser> {
    return this.config.createStructuredParser();
  }

  async createParser(): Promise<{ parse(file: FileToChunk): Promise<ParsedSourceFile> }> {
    try {
      const structured = await this.createStructuredParser();
      const parse = async (file: FileToChunk): Promise<ParsedSourceFile> => {
        try {
          const source = sourceFor(file);
          const result = await structured.parseStructured(source);
          if (result.status !== 'ok' && result.status !== 'degraded') {
            const fallback = this.config.parseFailureFallback;
            if (fallback !== undefined) return fallback(file);
            throw new Error(result.failure.message);
          }
          return projectLegacyResult(result, source, this.config.rootType);
        } catch (error) {
          if (error instanceof Error) this.config.onParseFailure?.(error);
          throw error;
        }
      };
      return { parse };
    } catch (error) {
      const fallback = this.config.initializationFallback;
      if (fallback === undefined || !(error instanceof Error)) throw error;
      this.config.onInitializationFailure?.(error);
      return { parse: async (file) => fallback(file) };
    }
  }
}

export const createTreeSitterLanguagePlugin = (
  config: TreeSitterLanguagePluginConfig,
): new () => TreeSitterLanguagePlugin => class extends TreeSitterLanguagePlugin {
  constructor() {
    super(config);
  }
};
