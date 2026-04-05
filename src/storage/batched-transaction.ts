export interface BatchedExecutionOptions<T> {
  items: T[];
  batchSize: number;
  yieldAfterBatch?: () => Promise<void>;
  executeBatch: (batch: T[], batchIndex: number) => Promise<void>;
}

export const executeBatchedWithYield = async <T>({
  items,
  batchSize,
  yieldAfterBatch,
  executeBatch,
}: BatchedExecutionOptions<T>): Promise<void> => {
  if (typeof batchSize !== 'number' || !Number.isInteger(batchSize) || !Number.isFinite(batchSize) || batchSize <= 0) {
    throw new RangeError('batchSize must be a positive integer');
  }

  for (let start = 0; start < items.length; start += batchSize) {
    const batch = items.slice(start, start + batchSize);
    await executeBatch(batch, start / batchSize);

    if (yieldAfterBatch !== undefined && start + batchSize < items.length) {
      await yieldAfterBatch();
    }
  }
};
