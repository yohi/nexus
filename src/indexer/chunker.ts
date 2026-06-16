import { createHash } from 'node:crypto';

import type { CodeChunk, FileToChunk, ParsedSourceFile } from '../types/index.js';
import type { PluginRegistry } from '../plugins/registry.js';

export interface FixedLineChunkOptions {
  windowSize?: number;
  overlap?: number;
}

export interface ChunkerOptions {
  /** Maximum number of characters per chunk before splitting. 0 = unlimited. */
  maxChunkChars?: number;
}

export class Chunker {
  private readonly maxChunkChars: number;

  constructor(private readonly pluginRegistry: PluginRegistry, options: ChunkerOptions = {}) {
    this.maxChunkChars = options.maxChunkChars ?? 0;
  }

  async chunkFiles(files: FileToChunk[]): Promise<CodeChunk[]> {
    const chunks: CodeChunk[] = [];

    for (const file of files) {
      const plugin = this.pluginRegistry.getLanguagePlugin(file.filePath);
      if (plugin === undefined) {
        chunks.push(...this.chunkByFixedLines(file));
        continue;
      }

      try {
        const parser = await plugin.createParser();
        const parsed = await parser.parse(file);
        if (!parsed.declarations || parsed.declarations.length === 0) {
          chunks.push(...this.chunkByFixedLines(file));
        } else {
          chunks.push(...(await this.extractChunksWithYield(parsed, file)));
        }
      } catch (error) {
        console.warn('Parser failed, falling back to fixed-line chunking', file.filePath, error);
        chunks.push(...this.chunkByFixedLines(file));
      }
    }

    return chunks;
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
      };

      const subChunks = this.splitByMaxChars(
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

  chunkByFixedLines(file: FileToChunk, options: FixedLineChunkOptions = {}): CodeChunk[] {
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

      const windowChunks = this.splitByMaxChars(
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
  private splitByMaxChars(
    content: string,
    startLine: number,
    baseName: string,
    filePath: string,
    meta: Omit<CodeChunk, 'id' | 'content' | 'startLine' | 'endLine' | 'hash'>,
  ): CodeChunk[] {
    if (this.maxChunkChars <= 0 || content.length <= this.maxChunkChars) {
      return [
        {
          ...meta,
          id: this.createChunkId(filePath, startLine, startLine + content.split('\n').length - 1, baseName),
          content,
          startLine,
          endLine: startLine + content.split('\n').length - 1,
          hash: this.hashContent(content),
        },
      ];
    }

    const lines = content.split('\n');
    const result: CodeChunk[] = [];
    let buf: string[] = [];
    let bufChars = 0;
    let chunkStart = startLine;
    let lineOffset = 0;

    const flush = () => {
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
        hash: this.hashContent(chunkContent),
      });
      chunkStart = chunkEnd + 1;
      buf = [];
      bufChars = 0;
    };

    for (const line of lines) {
      if (line.length > this.maxChunkChars) {
        // Line itself exceeds limit — flush current buffer then emit char-split sub-chunks
        flush();
        for (let pos = 0; pos < line.length; pos += this.maxChunkChars) {
          const piece = line.slice(pos, pos + this.maxChunkChars);
          const partIndex = result.length + 1;
          result.push({
            ...meta,
            id: this.createChunkId(filePath, startLine + lineOffset, startLine + lineOffset, `${baseName}-part${partIndex}`),
            content: piece,
            startLine: startLine + lineOffset,
            endLine: startLine + lineOffset,
            hash: this.hashContent(piece),
          });
        }
        lineOffset++;
        chunkStart = startLine + lineOffset;
        continue;
      }

      const addedChars = buf.length === 0 ? line.length : bufChars + 1 + line.length;
      if (addedChars > this.maxChunkChars && buf.length > 0) {
        flush();
      }
      buf.push(line);
      bufChars = buf.length === 1 ? line.length : bufChars + 1 + line.length;
      lineOffset++;
    }
    flush();

    return result;
  }

  private createChunkId(filePath: string, startLine: number, endLine: number, name: string): string {
    return `${filePath}:${startLine}-${endLine}:${name}`;
  }

  private hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }
}
