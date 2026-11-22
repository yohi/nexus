import { lstat, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { sha256 } from '../performance/fixture-recipe.js';
import type { QualityCaseManifest, QualityRootKey, PublicQualityTask } from './contracts.js';
import { validateQualityCases } from './contracts.js';
import { QUALITY_CASES_V1 } from './manifest.js';

export interface OwnedQualityFixture {
  readonly root: string;
  readonly roots: Readonly<Partial<Record<QualityRootKey, string>>>;
  readonly publicTasks: readonly PublicQualityTask[];
  readonly oracleCases: readonly QualityCaseManifest[];
  readonly dispose: () => Promise<void>;
}

export class QualitySetupError extends Error {
  readonly status = 'setup_incomplete' as const;

  constructor(readonly code: 'scenario_empty' | 'scenario_duplicate' | 'scenario_unknown') {
    super(code);
    this.name = 'QualitySetupError';
  }
}

type FixtureFileSpec = Readonly<{ path: string; source: string }>;
type ScenarioShape = Readonly<{
  readonly targetPath: string;
  readonly targetName: string;
  readonly files: readonly FixtureFileSpec[];
  readonly mutations: readonly QualityCaseManifest['mutationSchedule'][number][];
}>;

const owned = new WeakSet<OwnedQualityFixture>();
const mutationSources = new WeakMap<OwnedQualityFixture, ReadonlyMap<string, string>>();
const declarationRange = (path: string, source: string, expectedName: string): Readonly<{ startByte: number; endByte: number }> => {
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let match: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === expectedName && match === undefined) match = node;
    ts.forEachChild(node, visit);
  };
  visit(tree);
  if (match === undefined) throw new Error('quality_fixture_declaration_missing');
  return {
    startByte: Buffer.byteLength(source.slice(0, match.getStart(tree)), 'utf8'),
    endByte: Buffer.byteLength(source.slice(0, match.end), 'utf8'),
  };
};

function sourceFor(name: string, value = 42): string {
  return `export function ${name}(): number { return ${value}; }\n`;
}

function scenarioShape(task: QualityCaseManifest): ScenarioShape {
  const prefix = `${task.taskId}/`;
  const one = (file: string, name: string, source: string): ScenarioShape => ({
    targetPath: `${prefix}${file}`, targetName: name, files: [{ path: `${prefix}${file}`, source }], mutations: [],
  });
  switch (task.scenarioId) {
    case 'Q03@quality-v1':
      return { targetPath: `${prefix}new-name.ts`, targetName: 'renamedAnswer', mutations: [], files: [
        { path: `${prefix}old-name.ts`, source: sourceFor('oldAnswer') },
        { path: `${prefix}new-name.ts`, source: sourceFor('renamedAnswer') },
      ] };
    case 'Q04@quality-v1':
      return { targetPath: `${prefix}moved.ts`, targetName: 'calculate', mutations: [], files: [
        { path: `${prefix}before-move.ts`, source: sourceFor('calculate') },
        { path: `${prefix}moved.ts`, source: sourceFor('calculate') },
      ] };
    case 'Q05@quality-v1':
      return { ...one('src/deleted.ts', 'answer', sourceFor('answer')),
        mutations: [{ phase: 'before_publication', operation: 'delete', target: `${prefix}src/deleted.ts` }] };
    case 'Q06@quality-v1':
      return { ...one('src/recreated.ts', 'answer', sourceFor('answer')),
        mutations: [
          { phase: 'during_request', operation: 'delete', target: `${prefix}src/recreated.ts` },
          { phase: 'before_publication', operation: 'recreate', target: `${prefix}src/recreated.ts` },
        ] };
    case 'Q10@quality-v1':
      return { targetPath: `${prefix}scope-a.ts`, targetName: 'lookup', mutations: [], files: [
        { path: `${prefix}scope-a.ts`, source: sourceFor('lookup') },
        { path: `${prefix}scope-b.ts`, source: sourceFor('lookup', 43) },
      ] };
    case 'Q11@quality-v1': {
      const body = Array.from({ length: 40 }, (_, index) => `  const value${index} = ${index};`).join('\n');
      const source = `export function largeAnswer(): number {\n${body}\n  return value39;\n}\nexport function secondary(): number { return 2; }\n`;
      return one('large.ts', 'largeAnswer', source);
    }
    case 'Q14@quality-v1':
      return { ...one('answer.ts', 'answer', sourceFor('answer')),
        files: [...one('answer.ts', 'answer', sourceFor('answer')).files,
          { path: `${prefix}helper.py`, source: 'def helper():\n    return "quality"\n' }] };
    case 'Q01@quality-v1':
    case 'Q02@quality-v1':
    case 'Q07@quality-v1':
    case 'Q08@quality-v1':
    case 'Q09@quality-v1':
    case 'Q12@quality-v1':
    case 'Q13@quality-v1':
      return one('src/answer.ts', 'answer', sourceFor('answer'));
    default:
      throw new Error(`unsupported_quality_scenario:${task.scenarioId}`);
  }
}

function utf16Location(source: string, offset: number): Readonly<{ line: number; character: number }> {
  const before = source.slice(0, offset);
  const lines = before.split('\n');
  return { line: lines.length, character: lines.at(-1)?.length ?? 0 };
}

function sortedDigest(entries: readonly (readonly [string, string])[]): string {
  return sha256([...entries].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([path, digest]) => `${path}\0${digest}`).join('\n'));
}

export async function createQualityFixture(scenarioIds: readonly string[], signal: AbortSignal): Promise<OwnedQualityFixture> {
  signal.throwIfAborted();
  if (scenarioIds.length === 0) throw new QualitySetupError('scenario_empty');
  if (new Set(scenarioIds).size !== scenarioIds.length) throw new QualitySetupError('scenario_duplicate');
  const knownScenarios = new Set(QUALITY_CASES_V1.map(({ scenarioId }) => scenarioId));
  if (scenarioIds.some((scenarioId) => !knownScenarios.has(scenarioId))) throw new QualitySetupError('scenario_unknown');
  const selected = QUALITY_CASES_V1.filter((item) => scenarioIds.includes(item.scenarioId));
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nexus-quality-')));
  const roots: Partial<Record<QualityRootKey, string>> = {};
  const shapes = new Map(selected.map((task) => [task.taskId, scenarioShape(task)]));
  try {
    for (const key of new Set(selected.map((item) => item.worktreeIdentity.rootKey))) {
      signal.throwIfAborted();
      const projectRoot = join(root, key);
      await mkdir(projectRoot, { recursive: false });
      roots[key] = projectRoot;
      for (const task of selected.filter((item) => item.worktreeIdentity.rootKey === key)) {
        for (const file of shapes.get(task.taskId)?.files ?? []) {
          signal.throwIfAborted();
          const destination = join(projectRoot, file.path);
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, file.source, { encoding: 'utf8', flag: 'wx' });
        }
      }
    }
    signal.throwIfAborted();
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  const sourceSnapshotByRoot = new Map<QualityRootKey, string>();
  for (const key of Object.keys(roots) as QualityRootKey[]) {
    const entries: [string, string][] = [];
    for (const task of selected.filter((item) => item.worktreeIdentity.rootKey === key)) {
      for (const file of shapes.get(task.taskId)?.files ?? []) entries.push([file.path, sha256(file.source)]);
    }
    sourceSnapshotByRoot.set(key, sortedDigest(entries));
  }
  const mutationText = new Map<string, string>();
  const generatedCases = selected.map((task) => {
    const shape = shapes.get(task.taskId);
    if (shape === undefined) throw new QualitySetupError('scenario_unknown');
    const target = shape.files.find(({ path }) => path === shape.targetPath);
    if (target === undefined) throw new Error('quality_fixture_target_missing');
    const range = declarationRange(shape.targetPath, target.source, shape.targetName);
    const sourceBytes = new TextEncoder().encode(target.source);
    const sourceSlice = sourceBytes.slice(range.startByte, range.endByte);
    const start = new TextDecoder().decode(sourceBytes.slice(0, range.startByte)).length;
    const location = utf16Location(target.source, start);
    const rootSnapshot = sourceSnapshotByRoot.get(task.worktreeIdentity.rootKey);
    if (rootSnapshot === undefined) throw new Error('quality_fixture_root_missing');
    for (const mutation of shape.mutations) {
      if (mutation.operation === 'recreate') mutationText.set(`${task.taskId}\0${mutation.target}`, target.source.replace('42', '43'));
    }
    return {
      ...task,
      mutationSchedule: shape.mutations,
      sourceSnapshotDigest: rootSnapshot,
      expectedFiles: [shape.targetPath],
      expectedSymbols: [{ filePath: shape.targetPath, name: shape.targetName, ...range }],
      expectedSourceHashes: { [shape.targetPath]: sha256(sourceSlice) },
      expectedLocations: [{ filePath: shape.targetPath, ...location }],
    } satisfies QualityCaseManifest;
  });
  const oracleCases = validateQualityCases(generatedCases);
  let disposal: Promise<void> | undefined;
  const fixture: OwnedQualityFixture = Object.freeze({ root, roots: Object.freeze(roots),
    publicTasks: Object.freeze(oracleCases.map(({ taskDescription, initialClues }) => Object.freeze({ taskDescription, initialClues }))),
    oracleCases, dispose: () => disposal ??= rm(root, { recursive: true, force: true }) });
  owned.add(fixture);
  mutationSources.set(fixture, mutationText);
  return fixture;
}

export async function applyQualityMutation(fixture: OwnedQualityFixture, taskId: string,
  phase: 'before_request' | 'during_request' | 'before_publication'): Promise<void> {
  if (!owned.has(fixture)) throw new Error('quality_fixture_not_owned');
  const task = fixture.oracleCases.find((item) => item.taskId === taskId);
  if (task === undefined) throw new Error('quality_task_not_found');
  const projectRoot = fixture.roots[task.worktreeIdentity.rootKey];
  if (projectRoot === undefined) throw new Error('quality_root_not_found');
  const realProjectRoot = await realpath(projectRoot);
  for (const mutation of task.mutationSchedule.filter((entry) => entry.phase === phase)) {
    const destination = resolve(realProjectRoot, mutation.target);
    const pathFromRoot = relative(realProjectRoot, destination);
    if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`)) throw new Error('quality_mutation_outside_root');
    const parent = await realpath(dirname(destination));
    if (parent !== realProjectRoot && !parent.startsWith(`${realProjectRoot}${sep}`)) throw new Error('quality_mutation_outside_root');
    const info = await lstat(destination).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (info?.isSymbolicLink()) throw new Error('quality_mutation_symlink_rejected');
    if (mutation.operation === 'delete') await rm(destination, { force: true });
    else if (mutation.operation === 'recreate') {
      const source = mutationSources.get(fixture)?.get(`${taskId}\0${mutation.target}`);
      if (source === undefined) throw new Error('quality_mutation_source_missing');
      await writeFile(destination, source, { encoding: 'utf8', flag: 'wx' });
    } else if (mutation.operation === 'modify') {
      const source = mutationSources.get(fixture)?.get(`${taskId}\0${mutation.target}`);
      if (source === undefined) throw new Error('quality_mutation_source_missing');
      await writeFile(destination, source, { encoding: 'utf8' });
    } else if (mutation.operation !== 'noop') throw new Error('quality_mutation_unsupported');
  }
}
