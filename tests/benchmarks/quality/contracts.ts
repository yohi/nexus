import { z } from 'zod';

export type QualityArm = 'R' | 'N';
export type QualityProfile = 'quality-core-v1' | 'quality-worktree-v1' | 'quality-lsp-v1';
export type QualityRootKey = 'single' | 'primary' | 'linked';
export interface PrivateWorktreeIdentity { readonly rootKey: QualityRootKey; readonly role: 'single' | 'primary' | 'linked'; }
export type ObservationKind = 'CORRECT_CURRENT' | 'CORRECT_REFUSAL' | 'FALSE_REFUSAL' | 'FALSE_FRESH' | 'WRONG_SOURCE' | 'MISSING' | 'UNAVAILABLE' | 'INCONCLUSIVE';
export interface PublicQualityTask { readonly taskDescription: string; readonly initialClues: readonly string[]; }
export interface QualityBudgets { readonly maxLogicalOperations: 12; readonly maxCandidates: 20; readonly maxContextBytes: 65536; readonly maxRetries: 2; }
export interface QualityCaseManifest extends PublicQualityTask {
  readonly taskId: string;
  readonly scenarioId: string;
  readonly fixtureId: string;
  readonly sourceSnapshotDigest: string;
  readonly worktreeIdentity: PrivateWorktreeIdentity;
  readonly mutationSchedule: readonly { readonly phase: 'before_request' | 'during_request' | 'before_publication'; readonly operation: string; readonly target: string }[];
  readonly expectedFiles: readonly string[];
  readonly expectedSymbols: readonly { readonly filePath: string; readonly name: string; readonly startByte: number; readonly endByte: number }[];
  readonly expectedSourceHashes: Readonly<Record<string, string>>;
  readonly expectedLocations: readonly { readonly filePath: string; readonly line: number; readonly character: number }[];
  readonly expectedRefusalConditions: readonly string[];
  readonly evaluationEligibility: 'required_core' | 'conditional_worktree' | 'conditional_lsp';
}

export const QUALITY_BUDGETS_V1: QualityBudgets = Object.freeze({
  maxLogicalOperations: 12,
  maxCandidates: 20,
  maxContextBytes: 65536,
  maxRetries: 2,
});
export const policyVersion = 'quality-policy-v1';
export const qualityExecutionStatuses = ['executed', 'not_run', 'setup_incomplete', 'blocked'] as const;
export type QualityExecutionStatus = typeof qualityExecutionStatuses[number];

const rootKeySchema = z.enum(['single', 'primary', 'linked']);
const roleSchema = z.enum(['single', 'primary', 'linked']);
const manifestSchema = z.object({
  taskDescription: z.string().min(1),
  initialClues: z.array(z.string()).readonly(),
  taskId: z.string().min(1),
  scenarioId: z.string().regex(/^Q(?:0[1-9]|1[0-4])@quality-v1$/),
  fixtureId: z.string().min(1),
  sourceSnapshotDigest: z.string().regex(/^[a-f0-9]{64}$/),
  worktreeIdentity: z.object({ rootKey: rootKeySchema, role: roleSchema }).strict().readonly(),
  mutationSchedule: z.array(z.object({
    phase: z.enum(['before_request', 'during_request', 'before_publication']),
    operation: z.string().min(1),
    target: z.string().min(1),
  }).strict().readonly()).readonly(),
  expectedFiles: z.array(z.string().min(1)).readonly(),
  expectedSymbols: z.array(z.object({
    filePath: z.string().min(1), name: z.string().min(1),
    startByte: z.number().int().nonnegative(), endByte: z.number().int().nonnegative(),
  }).strict().readonly()).readonly(),
  expectedSourceHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)).readonly(),
  expectedLocations: z.array(z.object({
    filePath: z.string().min(1), line: z.number().int().positive(), character: z.number().int().nonnegative(),
  }).strict().readonly()).readonly(),
  expectedRefusalConditions: z.array(z.string().min(1)).readonly(),
  evaluationEligibility: z.enum(['required_core', 'conditional_worktree', 'conditional_lsp']),
}).strict().readonly().superRefine((manifest, context) => {
  if (manifest.worktreeIdentity.rootKey !== manifest.worktreeIdentity.role) {
    context.addIssue({ code: 'custom', message: 'worktree_role_mismatch', path: ['worktreeIdentity', 'role'] });
  }
  if ((manifest.scenarioId === 'Q07@quality-v1' || manifest.scenarioId === 'Q08@quality-v1') &&
      manifest.evaluationEligibility !== 'required_core') {
    context.addIssue({ code: 'custom', message: 'q07_q08_require_core_eligibility', path: ['evaluationEligibility'] });
  }
  if (manifest.scenarioId === 'Q12@quality-v1' &&
      (manifest.evaluationEligibility !== 'conditional_worktree' ||
       (manifest.taskId === 'Q12-primary' && manifest.worktreeIdentity.role !== 'primary') ||
       (manifest.taskId === 'Q12-linked' && manifest.worktreeIdentity.role !== 'linked') ||
       !['Q12-primary', 'Q12-linked'].includes(manifest.taskId))) {
    context.addIssue({ code: 'custom', message: 'q12_requires_matching_worktree_role', path: ['worktreeIdentity'] });
  }
  if (manifest.scenarioId === 'Q13@quality-v1' && manifest.evaluationEligibility !== 'conditional_lsp') {
    context.addIssue({ code: 'custom', message: 'q13_requires_lsp_eligibility', path: ['evaluationEligibility'] });
  }
});

export function validateQualityCase(input: unknown): QualityCaseManifest {
  return manifestSchema.parse(input);
}

export function publicTask(manifest: QualityCaseManifest): PublicQualityTask {
  const parsed = manifestSchema.parse(manifest);
  return Object.freeze({
    taskDescription: parsed.taskDescription,
    initialClues: Object.freeze([...parsed.initialClues]),
  });
}

export function validateQualityCases(input: unknown): readonly QualityCaseManifest[] {
  const cases = z.array(manifestSchema).min(1).readonly().parse(input);
  const taskIds = new Set<string>();
  for (const item of cases) {
    if (taskIds.has(item.taskId)) throw new Error('duplicate_task_id');
    taskIds.add(item.taskId);
  }
  return cases;
}
