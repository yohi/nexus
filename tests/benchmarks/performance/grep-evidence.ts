import { createHash } from 'node:crypto';
import type { GrepMatch } from '../../../src/types/index.js';
import { getObservationContext } from '../../../src/observability/runtime-observer.js';
import type { GrepEvidenceRef, ObservationContext } from '../../../src/observability/runtime-observer.js';
import type { ExpectedMatch, GrepMultisetProof, QueryCase } from './contracts.js';
import { logicalPathSchema } from './contracts.js';

type SnapshotMatch = Readonly<Omit<GrepMatch, 'submatches'> & {
  readonly submatches: readonly Readonly<GrepMatch['submatches'][number]>[];
}>;
type Snapshot = { readonly context: ObservationContext; readonly matches: readonly SnapshotMatch[] };
const owners = new WeakMap<GrepEvidenceRef, GrepEvidenceStore>();
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function multiset(rows: readonly ExpectedMatch[]) {
  const counts = new Map<string, number>();
  let submatchCount = 0;
  for (const row of rows) {
    const submatches = row.submatches.map((match) => [match.start, match.end, match.contentDigest] as const)
      .toSorted((left, right) => left[0] - right[0] || left[1] - right[1] || compare(left[2], right[2]));
    const key = hash(JSON.stringify({ path: row.path, line: row.line, lineDigest: row.lineDigest, submatches }));
    counts.set(key, (counts.get(key) ?? 0) + 1);
    submatchCount += submatches.length;
  }
  const digest = hash(JSON.stringify([...counts].toSorted(([left], [right]) => compare(left, right))));
  return { lineMatchCount: rows.length, submatchCount, digest };
}

export class GrepEvidenceStore {
  private readonly snapshots = new Map<GrepEvidenceRef, Snapshot>();

  get size(): number { return this.snapshots.size; }

  capture(context: ObservationContext, matches: readonly GrepMatch[]): GrepEvidenceRef {
    const evidence = Object.freeze({ token: Symbol('grep-evidence') });
    const snapshot = Object.freeze(matches.map((match) => Object.freeze({
      filePath: match.filePath, lineNumber: match.lineNumber, lineText: match.lineText,
      submatches: Object.freeze(match.submatches.map((submatch) => Object.freeze({ ...submatch }))),
    })));
    this.snapshots.set(evidence, { context: Object.freeze({ requestId: context.requestId, phaseId: context.phaseId }), matches: snapshot });
    owners.set(evidence, this);
    return evidence;
  }

  release(evidence: GrepEvidenceRef): void {
    this.snapshots.delete(evidence);
    owners.delete(evidence);
  }

  releaseRequest(requestId: string): void {
    for (const [reference, snapshot] of this.snapshots) {
      if (snapshot.context.requestId === requestId) this.release(reference);
    }
  }

  releaseAll(): void {
    for (const reference of this.snapshots.keys()) this.release(reference);
  }

  async validate(reference: GrepEvidenceRef, query: QueryCase,
    normalizePath: (path: string) => Promise<string>): Promise<GrepMultisetProof> {
    const algorithm = 'sha256-multiset-v1';
    try {
      const snapshot = this.snapshots.get(reference);
      const current = getObservationContext();
      if (snapshot === undefined) return { status: 'invalid', algorithm, reason: 'missing_evidence' };
      if (current?.requestId !== snapshot.context.requestId || current.phaseId !== snapshot.context.phaseId) {
        return { status: 'invalid', algorithm, reason: 'wrong_request_evidence' };
      }
      const rows: ExpectedMatch[] = [];
      for (const match of snapshot.matches) {
        let path: string;
        try { path = logicalPathSchema.parse(await normalizePath(match.filePath)); }
        catch { return { status: 'invalid', algorithm, reason: 'invalid_result_path' }; }
        if (!Number.isInteger(match.lineNumber) || match.lineNumber < 1 ||
          match.submatches.some((submatch) => !Number.isInteger(submatch.start) || !Number.isInteger(submatch.end) ||
            submatch.start < 0 || submatch.end < submatch.start)) {
          return { status: 'invalid', algorithm, reason: 'invalid_match_fields' };
        }
        rows.push({ path, line: match.lineNumber, lineDigest: hash(match.lineText),
          submatches: match.submatches.map((submatch) => ({ start: submatch.start, end: submatch.end,
            contentDigest: hash(submatch.match) })) });
      }
      const actual = multiset(rows);
      const expected = multiset(query.expectedMatches);
      if (actual.digest !== expected.digest || actual.lineMatchCount !== expected.lineMatchCount ||
        actual.submatchCount !== expected.submatchCount) {
        return { status: 'invalid', algorithm, reason: 'grep_multiset_mismatch', ...actual };
      }
      return { status: 'valid', algorithm, ...actual };
    } finally { this.release(reference); }
  }
}

export async function validateGrepEvidence(reference: GrepEvidenceRef, query: QueryCase,
  normalizePath: (path: string) => Promise<string>): Promise<GrepMultisetProof> {
  const owner = owners.get(reference);
  return owner === undefined ? { status: 'invalid', algorithm: 'sha256-multiset-v1', reason: 'missing_evidence' }
    : owner.validate(reference, query, normalizePath);
}
