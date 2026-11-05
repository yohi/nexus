import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { RuntimeEvent } from '../../../src/observability/runtime-observer.js';
import { assertNever } from './assert-never.js';

const count = z.number().int().nonnegative();
const outcomeCounts = z.object({ l1_hit: count, l2_hit: count, miss: count }).strict().readonly();
export const cacheAccountingSchema = z.object({
  outcomes: outcomeCounts,
  outcomesByOrigin: z.object({ legacy: outcomeCounts, structured: outcomeCounts }).strict().readonly(),
  providerCalls: count, submittedInputs: count,
  providerInputsByOrigin: z.object({ legacy: count, structured: count }).strict().readonly(),
  distinctProviderKeys: count, crossOriginSharedKeys: count, hasMissingIdentity: z.boolean(),
  providerInputMultisetDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().readonly();
export type CacheAccounting = z.infer<typeof cacheAccountingSchema>;

export function cacheAccountingFailures(events: readonly RuntimeEvent[]): readonly string[] {
  const failures = new Set<string>();
  const batches = new Map<string, { submitted: number; finished: number; workId: string }>();
  let misses = 0;
  let inputs = 0;
  for (const event of events) {
    switch (event.kind) {
      case 'cache_lookup': if (event.outcome === 'miss') misses += 1; break;
      case 'embedding_batch_submitted': case 'embedding_batch_finished': {
        const batch = batches.get(event.batchId) ?? { submitted: 0, finished: 0, workId: event.workId };
        if (batch.workId !== event.workId) failures.add('inconsistent_embedding_work');
        switch (event.kind) {
          case 'embedding_batch_submitted': batch.submitted += 1; inputs += event.entries.length; break;
          case 'embedding_batch_finished': batch.finished += 1; break;
          default: assertNever(event);
        }
        batches.set(event.batchId, batch);
        break;
      }
      case 'work_started': case 'work_finished': case 'reindex_finished': case 'grep_child_finished':
      case 'compaction_failed': case 'grep_invalid_match': case 'grep_signal': case 'grep_results_captured':
      case 'state_changed': case 'queue_state': case 'drain_state': break;
      default: assertNever(event);
    }
  }
  for (const batch of batches.values()) {
    if (batch.submitted !== 1 || batch.finished !== 1) failures.add('missing_embedding_outcome');
  }
  if (misses !== inputs) failures.add('cache_accounting_mismatch');
  return [...failures];
}

export function summarizeCacheEvents(events: readonly RuntimeEvent[]): CacheAccounting {
  const outcomes = { l1_hit: 0, l2_hit: 0, miss: 0 };
  const outcomesByOrigin = { legacy: { ...outcomes }, structured: { ...outcomes } };
  const providerInputsByOrigin = { legacy: 0, structured: 0 };
  const keys = { legacy: new Set<string>(), structured: new Set<string>() };
  const occurrences = new Map<string, number>();
  let providerCalls = 0;
  let submittedInputs = 0;
  let hasMissingIdentity = false;
  for (const event of events) {
    switch (event.kind) {
      case 'cache_lookup':
        outcomes[event.outcome] += 1;
        if (event.input.origin === undefined) hasMissingIdentity = true;
        else outcomesByOrigin[event.input.origin][event.outcome] += 1;
        break;
      case 'embedding_batch_submitted':
        providerCalls += 1;
        submittedInputs += event.entries.length;
        for (const entry of event.entries) {
          if (entry.origin === undefined) { hasMissingIdentity = true; continue; }
          providerInputsByOrigin[entry.origin] += 1;
          if (entry.keyDigest === undefined) hasMissingIdentity = true;
          else {
            keys[entry.origin].add(entry.keyDigest);
            occurrences.set(entry.keyDigest, (occurrences.get(entry.keyDigest) ?? 0) + 1);
          }
        }
        break;
      case 'work_started': case 'work_finished': case 'reindex_finished': case 'grep_child_finished':
      case 'compaction_failed': case 'grep_invalid_match': case 'grep_signal': case 'grep_results_captured':
      case 'state_changed': case 'queue_state': case 'drain_state': case 'embedding_batch_finished': break;
      default: assertNever(event);
    }
  }
  return cacheAccountingSchema.parse({ outcomes, outcomesByOrigin, providerCalls, submittedInputs,
    providerInputsByOrigin, distinctProviderKeys: new Set([...keys.legacy, ...keys.structured]).size,
    crossOriginSharedKeys: [...keys.legacy].filter((key) => keys.structured.has(key)).length, hasMissingIdentity,
    providerInputMultisetDigest: createHash('sha256').update(JSON.stringify([...occurrences].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest('hex') });
}
