import { validateQualityCases, type QualityCaseManifest } from './contracts.js';

const taskDefinitions = [
  { taskId: 'Q01', scenarioId: 'Q01@quality-v1', taskDescription: 'Clean indexed repository', evaluationEligibility: 'required_core', role: 'single' },
  { taskId: 'Q02', scenarioId: 'Q02@quality-v1', taskDescription: 'Dirty / uncommitted edits', evaluationEligibility: 'required_core', role: 'single' },
  { taskId: 'Q03', scenarioId: 'Q03@quality-v1', taskDescription: 'Symbol rename', evaluationEligibility: 'required_core', role: 'single' },
  { taskId: 'Q04', scenarioId: 'Q04@quality-v1', taskDescription: 'Symbol move', evaluationEligibility: 'required_core', role: 'single' },
  { taskId: 'Q05', scenarioId: 'Q05@quality-v1', taskDescription: 'Symbol deletion', evaluationEligibility: 'required_core', role: 'single' },
  { taskId: 'Q06', scenarioId: 'Q06@quality-v1', taskDescription: 'File deletion / recreation', evaluationEligibility: 'required_core', role: 'single' },
  { taskId: 'Q07', scenarioId: 'Q07@quality-v1', taskDescription: 'Stale semantic/vector data', evaluationEligibility: 'required_core', role: 'single' },
  { taskId: 'Q08', scenarioId: 'Q08@quality-v1', taskDescription: 'Generation changes during retrieval', evaluationEligibility: 'required_core', role: 'single' },
  { taskId: 'Q09', scenarioId: 'Q09@quality-v1', taskDescription: 'Partial / unsupported parsing', evaluationEligibility: 'required_core', role: 'single' },
  { taskId: 'Q10', scenarioId: 'Q10@quality-v1', taskDescription: 'Same names in multiple scopes', evaluationEligibility: 'required_core', role: 'single' },
  { taskId: 'Q11', scenarioId: 'Q11@quality-v1', taskDescription: 'Large file / multi-declaration', evaluationEligibility: 'required_core', role: 'single' },
  { taskId: 'Q14', scenarioId: 'Q14@quality-v1', taskDescription: 'LSP unavailable / unsupported', evaluationEligibility: 'required_core', role: 'single' },
  { taskId: 'Q12-primary', scenarioId: 'Q12@quality-v1', taskDescription: 'Divergent Git worktrees — primary root', evaluationEligibility: 'conditional_worktree', role: 'primary' },
  { taskId: 'Q12-linked', scenarioId: 'Q12@quality-v1', taskDescription: 'Divergent Git worktrees — linked root', evaluationEligibility: 'conditional_worktree', role: 'linked' },
  { taskId: 'Q13-definition', scenarioId: 'Q13@quality-v1', taskDescription: 'LSP definition', evaluationEligibility: 'conditional_lsp', role: 'single' },
  { taskId: 'Q13-references', scenarioId: 'Q13@quality-v1', taskDescription: 'LSP references', evaluationEligibility: 'conditional_lsp', role: 'single' },
  { taskId: 'Q13-implementations', scenarioId: 'Q13@quality-v1', taskDescription: 'LSP implementations', evaluationEligibility: 'conditional_lsp', role: 'single' },
] as const;

const qualityCases = taskDefinitions.map((definition) => ({
  taskId: definition.taskId,
  scenarioId: definition.scenarioId,
  fixtureId: 'nexus-quality-fixture-v1',
  sourceSnapshotDigest: '0'.repeat(64),
  taskDescription: definition.taskDescription,
  initialClues: ['Placeholder clue pending canonical fixture details.'],
  worktreeIdentity: { rootKey: definition.role, role: definition.role },
  mutationSchedule: [],
  expectedFiles: [],
  expectedSymbols: [],
  expectedSourceHashes: {},
  expectedLocations: [],
  expectedRefusalConditions: [],
  evaluationEligibility: definition.evaluationEligibility,
})) satisfies readonly QualityCaseManifest[];

export const QUALITY_CASES_V1 = validateQualityCases(qualityCases);
