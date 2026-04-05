import { createHash } from 'node:crypto';

import type { EmbeddingProvider } from '../../../../src/types/index.js';

export class TestEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 64;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const digest = createHash('sha256').update(text).digest();
      return Array.from({ length: this.dimensions }, (_, index) => (digest[index % digest.length] ?? 0) / 255);
    });
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
