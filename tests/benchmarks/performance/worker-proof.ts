import { z } from 'zod';

export const limitProofSchema = z.object({ requestedMemoryLimitMb: z.number().int().positive(),
  receivedMemoryLimitMb: z.number().int().nonnegative(), vmHeapLimitBytes: z.number().int().nonnegative(),
  peakHeapUsedBytes: z.number().int().nonnegative(), lifetimePeakRssBytes: z.number().int().nonnegative(),
  pid: z.number().int().positive() }).strict().readonly();
export const workerInfoSchema = limitProofSchema.unwrap().extend({ jobId: z.string().regex(/^[a-z0-9_-]+$/),
  timeoutMs: z.number().int().positive(), auditPageSize: z.number().int().min(1).max(512),
  cacheSeedBatchSize: z.literal(512), heapCeiling: z.literal('node_old_space_mib'), setupCovered: z.literal(true),
}).strict().readonly();
