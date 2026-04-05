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
        chunks.push(...(await this.extractChunksWithYield(parsed, file)));
      } catch {
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
        symbolKind: declaration.type as SymbolKind,
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
    const lines = file.content.split('\n');
    const chunks: CodeChunk[] = [];
    const step = Math.max(1, windowSize - overlap);

    for (let start = 0; start < lines.length; start += step) {
      const slice = lines.slice(start, start + windowSize);

      if (slice.length === 0) {
        continue;
      }

      const startLine = start + 1;
      const endLine = start + slice.length;
      const content = slice.join('\n');

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
    return createHash('sha1').update(content).digest('hex');
  }
}
