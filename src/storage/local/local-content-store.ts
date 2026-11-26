import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type {
  ContentRangeWithOffsets,
  IContentStore,
  IContentStoreFactory,
} from '../interfaces/content-store.js';

export interface LocalContentStoreDeps {
  readonly projectRoot: string;
  readonly sanitize: (filePath: string) => Promise<string>;
}

const clampLine = (line: number, totalLines: number): number => Math.max(1, Math.min(line, totalLines));

export class LocalContentStore implements IContentStore {
  constructor(private readonly deps: LocalContentStoreDeps) {}

  async put(_contentHash: string, _content: Uint8Array): Promise<void> {
    throw new Error('LocalContentStore.put is not implemented (Phase 4 scope)');
  }

  async get(_contentHash: string): Promise<Uint8Array | null> {
    return null;
  }

  async delete(_contentHash: string): Promise<void> {
    throw new Error('LocalContentStore.delete is not implemented (Phase 4 scope)');
  }

  async exists(_contentHash: string): Promise<boolean> {
    return false;
  }

  async readRange(
    filePath: string,
    startLine: number,
    endLine: number,
    signal?: AbortSignal,
  ): Promise<string> {
    return (await this.readRangeWithOffsets(filePath, startLine, endLine, signal)).content;
  }

  async readRangeWithOffsets(
    filePath: string,
    startLine: number,
    endLine: number,
    signal?: AbortSignal,
  ): Promise<ContentRangeWithOffsets> {
    const sanitizedPath = await this.deps.sanitize(filePath);
    const content = await readFile(resolve(this.deps.projectRoot, sanitizedPath), { signal });
    const lineStarts = [0];
    for (let byteOffset = 0; byteOffset < content.length; byteOffset += 1) {
      if (content[byteOffset] === 0x0a) lineStarts.push(byteOffset + 1);
    }
    const totalLines = lineStarts.length;
    const clampedStart = clampLine(startLine, totalLines);
    const clampedEnd = clampLine(endLine, totalLines);
    if (clampedStart > clampedEnd) {
      throw new Error(
        `Invalid line range: startLine (${clampedStart}) is greater than endLine (${clampedEnd})`,
      );
    }
    const startByte = lineStarts[clampedStart - 1] ?? content.length;
    const nextLineStart = lineStarts[clampedEnd];
    const endByte = nextLineStart === undefined ? content.length : nextLineStart - 1;

    return {
      content: content.subarray(startByte, endByte).toString('utf8'),
      startLine: clampedStart,
      endLine: clampedEnd,
      startByte,
      endByte,
    };
  }
}

export class LocalContentStoreFactory implements IContentStoreFactory {
  private readonly store: LocalContentStore;

  constructor(deps: LocalContentStoreDeps) {
    this.store = new LocalContentStore(deps);
  }

  getStore(workspaceId: string, revisionId: string): IContentStore {
    if (workspaceId.trim() === '') {
      throw new Error('workspaceId must be a non-empty string');
    }
    if (revisionId.trim() === '') {
      throw new Error('revisionId must be a non-empty string');
    }
    return this.store;
  }
}
