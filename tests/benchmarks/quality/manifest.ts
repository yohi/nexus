import { validateQualityCases, type QualityCaseManifest } from './contracts.js';

const taskDefinitions = [
  { taskId: 'Q01', scenarioId: 'Q01@quality-v1', taskDescription: 'Clean indexed repository', initialClues: ['id:answer'], evaluationEligibility: 'required_core', role: 'single' },
  { taskId: 'Q02', scenarioId: 'Q02@quality-v1', taskDescription: 'Dirty / uncommitted edits', initialClues: ['file:Q02/src/answer.ts'], evaluationEligibility: 'required_core', role: 'single' },
  { taskId: 'Q03', scenarioId: 'Q03@quality-v1', taskDescription: 'Symbol rename', initialClues: ['id:oldAnswer'], evaluationEligibility: 'required_core', role: 'single' },
  { taskId: 'Q04', scenarioId: 'Q04@quality-v1', taskDescription: 'Symbol move', initialClues: ['file:Q04/moved.ts'], evaluationEligibility: 'required_core', role: 'single' },
  { taskId: 'Q05', scenarioId: 'Q05@quality-v1', taskDescription: 'Symbol deletion', initialClues: ['file:Q05/src/deleted.ts'], evaluationEligibility: 'required_core', role: 'single' },
  { taskId: 'Q06', scenarioId: 'Q06@quality-v1', taskDescription: 'File deletion / recreation', initialClues: ['file:Q06/src/recreated.ts'], evaluationEligibility: 'required_core', role: 'single' },
  { taskId: 'Q07', scenarioId: 'Q07@quality-v1', taskDescription: 'Stale semantic/vector data', initialClues: ['file:Q07/src/answer.ts'], evaluationEligibility: 'required_core', role: 'single' },
  { taskId: 'Q08', scenarioId: 'Q08@quality-v1', taskDescription: 'Generation changes during retrieval', initialClues: ['file:Q08/src/answer.ts'], evaluationEligibility: 'required_core', role: 'single' },
  { taskId: 'Q09', scenarioId: 'Q09@quality-v1', taskDescription: 'Partial / unsupported parsing', initialClues: ['file:Q09/src/answer.ts'], evaluationEligibility: 'required_core', role: 'single' },
  { taskId: 'Q10', scenarioId: 'Q10@quality-v1', taskDescription: 'Same names in multiple scopes', initialClues: ['symbol:lookup', 'file:Q10/scope-a.ts'], evaluationEligibility: 'required_core', role: 'single' },
  { taskId: 'Q11', scenarioId: 'Q11@quality-v1', taskDescription: 'Large file / multi-declaration', initialClues: ['file:Q11/large.ts'], evaluationEligibility: 'required_core', role: 'single' },
  { taskId: 'Q14', scenarioId: 'Q14@quality-v1', taskDescription: 'LSP unavailable / unsupported', initialClues: ['file:Q14/answer.ts'], evaluationEligibility: 'required_core', role: 'single' },
  { taskId: 'Q12-primary', scenarioId: 'Q12@quality-v1', taskDescription: 'Divergent Git worktrees — primary root', initialClues: ['file:Q12-primary/src/answer.ts'], evaluationEligibility: 'conditional_worktree', role: 'primary' },
  { taskId: 'Q12-linked', scenarioId: 'Q12@quality-v1', taskDescription: 'Divergent Git worktrees — linked root', initialClues: ['file:Q12-linked/src/answer.ts'], evaluationEligibility: 'conditional_worktree', role: 'linked' },
  { taskId: 'Q13-definition', scenarioId: 'Q13@quality-v1', taskDescription: 'LSP definition', initialClues: ['position:Q13-definition/src/answer.ts@1:15', 'nav:definition'], evaluationEligibility: 'conditional_lsp', role: 'single' },
  { taskId: 'Q13-references', scenarioId: 'Q13@quality-v1', taskDescription: 'LSP references', initialClues: ['position:Q13-references/src/answer.ts@1:15', 'nav:references'], evaluationEligibility: 'conditional_lsp', role: 'single' },
  { taskId: 'Q13-implementations', scenarioId: 'Q13@quality-v1', taskDescription: 'LSP implementations', initialClues: ['position:Q13-implementations/src/answer.ts@1:15', 'nav:implementations'], evaluationEligibility: 'conditional_lsp', role: 'single' },
] as const;

const qualityCases = taskDefinitions.map((definition) => ({
  taskId: definition.taskId,
  scenarioId: definition.scenarioId,
  fixtureId: 'nexus-quality-fixture-v1',
  sourceSnapshotDigest: '0'.repeat(64),
  taskDescription: definition.taskDescription,
  initialClues: definition.initialClues,
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
