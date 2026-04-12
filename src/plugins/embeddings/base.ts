import type { EmbeddingProvider } from '../../types/index.js';

export abstract class BaseEmbeddingProvider implements EmbeddingProvider {
  abstract readonly dimensions: number;

  abstract embed(texts: string[]): Promise<number[][]>;
  abstract healthCheck(): Promise<boolean>;

  protected chunkTexts(texts: string[], batchSize: number): string[][] {
    const batches: string[][] = [];

    for (let index = 0; index < texts.length; index += batchSize) {
      batches.push(texts.slice(index, index + batchSize));
    }

    return batches;
  }
}
