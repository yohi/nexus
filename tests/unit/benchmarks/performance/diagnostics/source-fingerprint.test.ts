import { execFile } from 'node:child_process';
import { chmod } from 'node:fs/promises';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';

type SourceFingerprintResult = Readonly<{
  commit: string | null;
  dirtySourcePaths: readonly string[];
  digest: string;
}>;
type SourceFingerprintModule = Readonly<{
  diagnosticSourceFingerprint: (repository: string, services?: Readonly<{
    runGit: (args: readonly string[], cwd: string) => Promise<string | null>;
  }>) => Promise<SourceFingerprintResult>;
}>;

const snapshotSchema = z.object({
  commit: z.string().nullable(),
  dirtySourcePaths: z.array(z.string()),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const roots: string[] = [];
const runFile = promisify(execFile);

function isSourceFingerprintModule(value: unknown): value is SourceFingerprintModule {
  return typeof value === 'object' && value !== null
    && 'diagnosticSourceFingerprint' in value && typeof value.diagnosticSourceFingerprint === 'function';
}

async function loadSourceFingerprintModule(): Promise<SourceFingerprintModule> {
  const moduleUrl = pathToFileURL(resolve(process.cwd(), 'scripts/performance-diagnostics/source-fingerprint.mjs')).href;
  let loaded: unknown;
  try {
    loaded = await import(moduleUrl);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    loaded = undefined;
  }
  expect(isSourceFingerprintModule(loaded)).toBe(true);
  if (!isSourceFingerprintModule(loaded)) throw new Error('diagnostic_source_fingerprint_missing');
  return loaded;
}

async function createSourceTree(): Promise<{ readonly root: string; readonly files: readonly string[] }> {
  const root = await mkdtemp(join(tmpdir(), 'nexus-diagnostic-fingerprint-'));
  roots.push(root);
  const files = [
    'src/indexer/pipeline.ts',
    'tests/benchmarks/performance/worker-scenario.ts',
    'tests/unit/benchmarks/performance/diagnostics/source-fingerprint.test.ts',
    'tests/unit/benchmarks/performance/discovery.test.ts',
    'scripts/run-performance-diagnostic.mjs',
    'scripts/run-performance-diagnostic.d.mts',
    'scripts/execute-performance-diagnostic.mjs',
    'scripts/performance-diagnostics/v4/profile-event-sink.cjs',
    'scripts/performance-diagnostics/v4/clock_conformance.py',
    'scripts/performance-diagnostics/v4/README.md',
    'scripts/performance-diagnostics/diagnostic-source-pin.json',
    'scripts/performance-diagnostics/new-helper.mjs',
    'scripts/performance-diagnostics/ignored-generated.mjs',
    'scripts/performance-diagnostics/profiles/raw.cpuprofile',
    'nexus-performance-diagnostics-v2.zip',
    'reports/performance-execution/r5/R5-03-minimal-implementation-tdd-plan.md',
    'docs/observability/benchmarks/small.json',
    'package.json',
    'package-lock.json',
    'vitest.performance.config.ts',
    'vitest.diagnostic-performance.config.ts',
    'vitest.config.ts',
    'eslint.config.mjs',
    '.gitignore',
  ] as const;
  await Promise.all(files.map(async (file) => {
    const path = join(root, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `fixture:${file}\n`, 'utf8');
  }));
  return { root, files };
}

function createGitRunner(files: readonly string[], status: string) {
  return (args: readonly string[]): Promise<string | null> => {
    if (args[0] === 'rev-parse') return Promise.resolve(`${'a'.repeat(40)}\n`);
    if (args[0] === 'ls-files') return Promise.resolve(`${files.join('\0')}\0`);
    if (args[0] === 'status') return Promise.resolve(status);
    return Promise.resolve(null);
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('fingerprints_diagnostic_sources_and_excludes_user_artifacts_and_ignored_reports', async () => {
  const { root, files } = await createSourceTree();
  const status = [
    ' M src/indexer/pipeline.ts',
    '?? scripts/performance-diagnostics/new-helper.mjs',
    '!! scripts/performance-diagnostics/ignored-generated.mjs',
    '?? scripts/performance-diagnostics/profiles/raw.cpuprofile',
    '?? nexus-performance-diagnostics-v2.zip',
    '?? reports/performance-execution/r5/R5-03-minimal-implementation-tdd-plan.md',
    '?? scripts/performance-diagnostics/diagnostic-source-pin.json',
    '',
  ].join('\0');
  const fixture = (args: readonly string[]) => {
    if (args[0] === 'ls-files' && !args.includes('--ignored')) {
      return Promise.resolve(`${files.filter((file) => file !== 'scripts/performance-diagnostics/ignored-generated.mjs').join('\0')}\0`);
    }
    return createGitRunner(files, status)(args);
  };
  const source = await loadSourceFingerprintModule();

  const first = snapshotSchema.parse(await source.diagnosticSourceFingerprint(root, { runGit: fixture }));
  const stable = snapshotSchema.parse(await source.diagnosticSourceFingerprint(root, { runGit: fixture }));
  expect(first).toEqual(stable);
  expect(first.commit).toBe('a'.repeat(40));
  expect(first.dirtySourcePaths).toEqual([
    'scripts/performance-diagnostics/ignored-generated.mjs',
    'scripts/performance-diagnostics/new-helper.mjs',
    'src/indexer/pipeline.ts',
  ]);

  await writeFile(join(root, 'vitest.diagnostic-performance.config.ts'), 'fixture:diagnostic-config-changed\n', 'utf8');
  const changedDiagnosticConfig = snapshotSchema.parse(await source.diagnosticSourceFingerprint(root, { runGit: fixture }));
  expect(changedDiagnosticConfig.digest).not.toBe(first.digest);

  await writeFile(join(root, 'scripts/performance-diagnostics/ignored-generated.mjs'), 'fixture:ignored-source-changed\n', 'utf8');
  const changedIgnoredSource = snapshotSchema.parse(await source.diagnosticSourceFingerprint(root, { runGit: fixture }));
  expect(changedIgnoredSource.digest).not.toBe(changedDiagnosticConfig.digest);

  await writeFile(join(root, 'docs/observability/benchmarks/small.json'), 'fixture:baseline-changed\n', 'utf8');
  const changedBaseline = snapshotSchema.parse(await source.diagnosticSourceFingerprint(root, { runGit: fixture }));
  expect(changedBaseline.digest).not.toBe(changedDiagnosticConfig.digest);

  await writeFile(join(root, 'scripts/run-performance-diagnostic.d.mts'), 'fixture:declaration-changed\n', 'utf8');
  const changedDeclaration = snapshotSchema.parse(await source.diagnosticSourceFingerprint(root, { runGit: fixture }));
  expect(changedDeclaration.digest).not.toBe(changedBaseline.digest);

  await writeFile(join(root, 'vitest.config.ts'), 'fixture:base-config-changed\n', 'utf8');
  const changedBaseConfig = snapshotSchema.parse(await source.diagnosticSourceFingerprint(root, { runGit: fixture }));
  expect(changedBaseConfig.digest).not.toBe(changedDeclaration.digest);

  await writeFile(join(root, 'tests/unit/benchmarks/performance/discovery.test.ts'), 'fixture:discovery-test-changed\n', 'utf8');
  const changedDiscoveryTest = snapshotSchema.parse(await source.diagnosticSourceFingerprint(root, { runGit: fixture }));
  expect(changedDiscoveryTest.digest).not.toBe(changedBaseConfig.digest);

  await writeFile(join(root, 'scripts/performance-diagnostics/v4/clock_conformance.py'), 'fixture:changed\n', 'utf8');
  const changed = snapshotSchema.parse(await source.diagnosticSourceFingerprint(root, { runGit: fixture }));
  expect(changed.digest).not.toBe(first.digest);

  const pinContents = await readFile(join(root, 'scripts/performance-diagnostics/diagnostic-source-pin.json'), 'utf8');
  await writeFile(join(root, 'scripts/performance-diagnostics/diagnostic-source-pin.json'), `${pinContents}changed\n`, 'utf8');
  const changedPinOnly = snapshotSchema.parse(await source.diagnosticSourceFingerprint(root, { runGit: fixture }));
  expect(changedPinOnly.digest).toBe(changed.digest);
});

it('uses_the_trusted_git_executable_when_PATH_contains_an_untrusted_git', async () => {
  const { root } = await createSourceTree();
  const trustedGit = '/usr/bin/git';
  await runFile(trustedGit, ['init', '--quiet'], { cwd: root });
  await runFile(trustedGit, ['config', 'user.email', 'test@example.invalid'], { cwd: root });
  await runFile(trustedGit, ['config', 'user.name', 'Test'], { cwd: root });
  await runFile(trustedGit, ['add', 'src/indexer/pipeline.ts'], { cwd: root });
  await runFile(trustedGit, ['commit', '--quiet', '-m', 'fixture'], { cwd: root });
  const directory = await mkdtemp(join(tmpdir(), 'nexus-untrusted-git-'));
  roots.push(directory);
  const marker = join(directory, 'invoked');
  await writeFile(join(directory, 'git'), '#!/bin/sh\nprintf invoked > "$SONAR_TEST_MARKER"\nexit 1\n', 'utf8');
  await chmod(join(directory, 'git'), 0o700);
  const previousPath = process.env.PATH;
  const previousMarker = process.env.SONAR_TEST_MARKER;

  try {
    process.env.PATH = directory;
    process.env.SONAR_TEST_MARKER = marker;

    const source = await loadSourceFingerprintModule();
    const result = await source.diagnosticSourceFingerprint(root);

    expect(result.commit).toMatch(/^[a-f0-9]{40}$/);
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousMarker === undefined) delete process.env.SONAR_TEST_MARKER;
    else process.env.SONAR_TEST_MARKER = previousMarker;
  }
});
