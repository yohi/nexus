import { createHash } from 'node:crypto';

import type { CodeChunk, FileToChunk, ParsedSourceFile, SymbolKind } from '../types/index.js';
import type { PluginRegistry } from '../plugins/registry.js';

export interface FixedLineChunkOptions {
  windowSize?: number;
  overlap?: number;
}

export class Chunker {
  constructor(private readonly pluginRegistry: PluginRegistry) {}

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
      chunks.push({
        id: this.createChunkId(file.filePath, declaration.startLine, declaration.endLine, declaration.name),
        filePath: file.filePath,
        content: declaration.content,
        language: file.language,
        symbolName: declaration.name,
        symbolKind: declaration.type,
        startLine: declaration.startLine,
        endLine: declaration.endLine,
        hash: this.hashContent(declaration.content),
      });

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

      chunks.push({
        id: this.createChunkId(file.filePath, startLine, endLine, `file-${chunks.length + 1}`),
        filePath: file.filePath,
        content,
        language: file.language,
        symbolName: undefined,
        symbolKind: 'file',
        startLine,
        endLine,
        hash: this.hashContent(content),
      });

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

  private createChunkId(filePath: string, startLine: number, endLine: number, name: string): string {
    return `${filePath}:${startLine}-${endLine}:${name}`;
  }

  private hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }
}
