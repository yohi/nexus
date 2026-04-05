export interface BatchedExecutionOptions<T> {
  items: T[];
  batchSize: number;
  yieldAfterBatch?: () => Promise<void>;
  executeBatch: (batch: T[], batchIndex: number) => void;
}

export const executeBatchedWithYield = async <T>({
  items,
  batchSize,
  yieldAfterBatch,
  executeBatch,
}: BatchedExecutionOptions<T>): Promise<void> => {
  if (batchSize <= 0) {
    throw new RangeError('batchSize must be greater than 0');
  }

  for (let start = 0; start < items.length; start += batchSize) {
    const batch = items.slice(start, start + batchSize);
    executeBatch(batch, start / batchSize);

    if (yieldAfterBatch !== undefined && start + batchSize < items.length) {
      await yieldAfterBatch();
    }
  }
};
