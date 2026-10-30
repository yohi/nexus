import { computeStringHash } from './hash.js';

import type { CodeChunk, FileToChunk, ParsedSourceFile } from '../types/index.js';
import type { PluginRegistry } from '../plugins/registry.js';
import type { StructuredParseResult, StructuredDeclaration } from '../structured/contracts.js';
import { decodeUtf8 } from '../structured/hash.js';

export interface FixedLineChunkOptions {
  windowSize?: number;
  overlap?: number;
}

export interface ChunkerOptions {
  /** Maximum number of characters per chunk before splitting. 0 = unlimited. */
  maxChunkChars?: number;
}

export type ChunkFallbackReason = 'no_plugin' | 'empty_parse' | 'parser_error';
export type ChunkFallbackObserver = (reason: ChunkFallbackReason) => void;
export type ParserOutcome = 'attempted' | 'succeeded' | 'failed';
export type ParserOutcomeObserver = (outcome: ParserOutcome) => void;
export type ChunkerDiagnosticObserver = ChunkFallbackObserver | Readonly<{
  onFallback: ChunkFallbackObserver;
  onParserOutcome: ParserOutcomeObserver;
}>;

type GeneratedChunkFields = 'id' | 'content' | 'startLine' | 'endLine' | 'hash';

export class Chunker {
  private readonly maxChunkChars: number;

  constructor(private readonly pluginRegistry: PluginRegistry, options: ChunkerOptions = {}) {
    this.maxChunkChars = options.maxChunkChars ?? 0;
  }

  async chunkFiles(files: FileToChunk[], observer?: ChunkerDiagnosticObserver): Promise<CodeChunk[]> {
    const chunks: CodeChunk[] = [];
    const fallbackObserver = typeof observer === 'function' ? observer : observer?.onFallback;
    const parserOutcomeObserver = typeof observer === 'function' ? undefined : observer?.onParserOutcome;
    const reportFallback = (reason: ChunkFallbackReason): void => {
      try { fallbackObserver?.(reason); } catch { /* Diagnostic observers cannot affect chunk output. */ }
    };
    const reportParserOutcome = (outcome: ParserOutcome): void => {
      try { parserOutcomeObserver?.(outcome); } catch { /* Diagnostic observers cannot affect chunk output. */ }
    };

    for (const file of files) {
      const plugin = this.pluginRegistry.getLanguagePlugin(file.filePath);
      if (plugin === undefined) {
        reportFallback('no_plugin');
        chunks.push(...(await this.chunkByFixedLines(file)));
        continue;
      }

      let parserSucceeded = false;
      try {
        reportParserOutcome('attempted');
        const parser = await plugin.createParser();
        const parsed = await parser.parse(file);
        parserSucceeded = true;
        reportParserOutcome('succeeded');
        if (!parsed.declarations || parsed.declarations.length === 0) {
          reportFallback('empty_parse');
          chunks.push(...(await this.chunkByFixedLines(file)));
        } else {
          chunks.push(...(await this.extractChunksWithYield(parsed, file)));
        }
      } catch (error) {
        if (!parserSucceeded) reportParserOutcome('failed');
        reportFallback('parser_error');
        console.warn('Parser failed, falling back to fixed-line chunking', file.filePath, error);
        chunks.push(...(await this.chunkByFixedLines(file)));
      }
    }

    return chunks;
  }

  async chunkStructuredFile(
    file: FileToChunk,
    artifact: Pick<StructuredParseResult, 'declarations' | 'imports'>,
  ): Promise<CodeChunk[]> {
    const chunks: CodeChunk[] = [];

    for (const [index, declaration] of artifact.declarations.entries()) {
      chunks.push(...(await this.extractDeclarationChunks(declaration, file)));

      if ((index + 1) % 50 === 0) {
        await this.yieldToEventLoop();
      }
    }

    return chunks;
  }

  private async extractDeclarationChunks(
    declaration: StructuredDeclaration,
    file: FileToChunk,
  ): Promise<CodeChunk[]> {
    const base: Omit<CodeChunk, GeneratedChunkFields> = {
      filePath: file.filePath,
      language: file.language,
      symbolName: declaration.name,
      symbolKind: declaration.kind,
      symbolId: declaration.symbolId,
    };

    const content = declaration.rawSource ?? this.declarationContent(declaration, file);
    const contentStartLine = declaration.rawSource === undefined
      ? declaration.position.startLine
      : Math.max(1, declaration.position.endLine - this.countLines(content) + 1);
    const subChunks = await this.splitByMaxChars(
      content,
      contentStartLine,
      declaration.name,
      file.filePath,
      base,
    );

    // Align line ranges to the declaration boundaries when rawSource is available.
    if (declaration.rawSource !== undefined && subChunks.length > 1) {
      const endLine = declaration.position.endLine;
      for (const [index, chunk] of subChunks.entries()) {
        chunk.endLine = Math.max(chunk.startLine, Math.min(chunk.endLine, endLine));
        chunk.id = this.createChunkId(
          file.filePath,
          chunk.startLine,
          chunk.endLine,
          `${declaration.name}-part${index + 1}`,
        );
      }
    }

    return subChunks;
  }

  private declarationContent(declaration: StructuredDeclaration, file: FileToChunk): string {
    if (file.bytes !== undefined) {
      return decodeUtf8(file.bytes.subarray(declaration.startByte, declaration.endByte));
    }

    const lines = file.content.split('\n');
    return lines.slice(declaration.position.startLine - 1, declaration.position.endLine).join('\n');
  }

  async extractChunksWithYield(
    rootNode: ParsedSourceFile,
    file: FileToChunk,
    yieldFn: () => Promise<void> = this.yieldToEventLoop,
  ): Promise<CodeChunk[]> {
    const chunks: CodeChunk[] = [];

    for (const [index, declaration] of rootNode.declarations.entries()) {
      const base: Omit<CodeChunk, 'id' | 'content' | 'startLine' | 'endLine' | 'hash'> = {
        filePath: file.filePath,
        language: file.language,
        symbolName: declaration.name,
        symbolKind: declaration.type,
        symbolId: declaration.symbolId,
      };

      const subChunks = await this.splitByMaxChars(
        declaration.content,
        declaration.startLine,
        declaration.name,
        file.filePath,
        base,
      );
      chunks.push(...subChunks);

      if ((index + 1) % 50 === 0) {
        await yieldFn();
      }
    }

    return chunks;
  }

  async chunkByFixedLines(file: FileToChunk, options: FixedLineChunkOptions = {}): Promise<CodeChunk[]> {
    const windowSize = options.windowSize ?? 50;
    const overlap = options.overlap ?? 10;

    if (!Number.isInteger(windowSize) || windowSize <= 0) {
      throw new RangeError('windowSize must be a positive integer');
    }
    if (!Number.isInteger(overlap) || overlap < 0 || overlap >= windowSize) {
      throw new RangeError('overlap must be a non-negative integer less than windowSize');
    }

    const lines = file.content.split('\n');
    if (lines.length === 1 && lines[0] === '') {
      return [];
    }

    if (lines.length > 0 && lines[lines.length - 1] === '' && file.content.endsWith('\n')) {
      lines.pop();
    }

    const chunks: CodeChunk[] = [];
    const step = Math.max(1, windowSize - overlap);

    for (let start = 0; start < lines.length; start += step) {
      const slice = lines.slice(start, start + windowSize);

      if (slice.length === 0) {
        break;
      }

      const startLine = start + 1;
      const endLine = start + slice.length;
      const content = slice.join('\n');

      const lastChunk = chunks[chunks.length - 1];
      if (lastChunk && lastChunk.endLine === endLine) {
        break;
      }

      const windowChunks = await this.splitByMaxChars(
        content,
        startLine,
        `file-${chunks.length + 1}`,
        file.filePath,
        {
          filePath: file.filePath,
          language: file.language,
          symbolName: undefined,
          symbolKind: 'file',
        },
        slice,
      );
      chunks.push(...windowChunks);

      if (endLine === lines.length) {
        break;
      }
    }

    return chunks;
  }

  yieldToEventLoop = async (): Promise<void> =>
    new Promise((resolve) => {
      setImmediate(resolve);
    });

  /**
   * Splits `content` into chunks each no longer than `maxChunkChars`.
   * If maxChunkChars is 0 (unlimited), returns a single chunk.
   * Splits on line boundaries where possible; falls back to char splits for
   * lines longer than the limit.
   */
  private async splitByMaxChars(
    content: string,
    startLine: number,
    baseName: string,
    filePath: string,
    meta: Omit<CodeChunk, 'id' | 'content' | 'startLine' | 'endLine' | 'hash'>,
    lines?: string[],
  ): Promise<CodeChunk[]> {
    if (this.maxChunkChars <= 0 || content.length <= this.maxChunkChars) {
      const lineCount = lines ? lines.length : this.countLines(content);
      return [
        {
          ...meta,
          id: this.createChunkId(filePath, startLine, startLine + lineCount - 1, baseName),
          content,
          startLine,
          endLine: startLine + lineCount - 1,
          hash: await this.hashContent(content),
        },
      ];
    }

    const contentLines = lines ?? content.split('\n');
    const result: CodeChunk[] = [];
    let buf: string[] = [];
    let bufChars = 0;
    let chunkStart = startLine;
    let lineOffset = 0;

    const flush = async () => {
      if (buf.length === 0) return;
      const chunkContent = buf.join('\n');
      const chunkEnd = chunkStart + buf.length - 1;
      const partIndex = result.length + 1;
      result.push({
        ...meta,
        id: this.createChunkId(filePath, chunkStart, chunkEnd, `${baseName}-part${partIndex}`),
        content: chunkContent,
        startLine: chunkStart,
        endLine: chunkEnd,
        hash: await this.hashContent(chunkContent),
      });
      chunkStart = chunkEnd + 1;
      buf = [];
      bufChars = 0;
    };

    for (const line of contentLines) {
      if (line.length > this.maxChunkChars) {
        // Line itself exceeds limit — flush current buffer then emit char-split sub-chunks
        await flush();
        for (let pos = 0; pos < line.length; pos += this.maxChunkChars) {
          const piece = line.slice(pos, pos + this.maxChunkChars);
          const partIndex = result.length + 1;
          result.push({
            ...meta,
            id: this.createChunkId(filePath, startLine + lineOffset, startLine + lineOffset, `${baseName}-part${partIndex}`),
            content: piece,
            startLine: startLine + lineOffset,
            endLine: startLine + lineOffset,
            hash: await this.hashContent(piece),
          });
        }
        lineOffset++;
        chunkStart = startLine + lineOffset;
        continue;
      }

      const addedChars = buf.length === 0 ? line.length : bufChars + 1 + line.length;
      if (addedChars > this.maxChunkChars && buf.length > 0) {
        await flush();
      }
      buf.push(line);
      bufChars = buf.length === 1 ? line.length : bufChars + 1 + line.length;
      lineOffset++;
    }
    await flush();

    return result;
  }

  private createChunkId(filePath: string, startLine: number, endLine: number, name: string): string {
    return `${filePath}:${startLine}-${endLine}:${name}`;
  }

  private async hashContent(content: string): Promise<string> {
    return computeStringHash(content);
  }

  private countLines(content: string): number {
    let count = 1;
    for (let i = 0; i < content.length; i++) {
      if (content.charCodeAt(i) === 10) count++;
    }
    return count;
  }
}
