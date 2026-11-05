import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
import { compareStrings } from './diagnostic-string-order.mjs';

const includedRoots = Object.freeze([
  'src/',
  'tests/benchmarks/performance/',
  'tests/integration/performance/',
  'tests/unit/benchmarks/performance/diagnostics/',
  'scripts/performance-diagnostics/',
]);
const includedFiles = Object.freeze([
  '.gitignore',
  'eslint.config.mjs',
  'package.json',
  'package-lock.json',
  'scripts/execute-performance-diagnostic.mjs',
  'scripts/performance-source.mjs',
  'scripts/run-performance-diagnostic.mjs',
  'scripts/run-performance-diagnostic.d.mts',
  'scripts/run-performance.mjs',
  'docs/observability/benchmarks/small.json',
  'tests/unit/benchmarks/performance/discovery.test.ts',
  'tsconfig.json',
  'vitest.config.ts',
  'vitest.performance.config.ts',
  'vitest.diagnostic-performance.config.ts',
]);
const excludedFiles = new Set([
  'scripts/performance-diagnostics/diagnostic-source-pin.json',
]);
const diagnosticKitExtensions = Object.freeze(['.cjs', '.mjs', '.md', '.mts', '.py', '.ts']);
const sourcePathspecs = Object.freeze([
  ...includedRoots.map((root) => `:(top,glob)${root}**`),
  ...includedFiles.map((path) => `:(top,literal)${path}`),
]);
const maxCommandOutputBytes = 16 * 1024 * 1024;
const GIT_EXECUTABLE = '/usr/bin/git';

function runGit(args, cwd) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  env.PATH = '/usr/bin:/bin';
  return new Promise((resolveOutput) => execFile(GIT_EXECUTABLE, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: maxCommandOutputBytes,
  }, (error, stdout) => resolveOutput(error === null ? stdout : null)));
}

function isDiagnosticSourcePath(path) {
  if (excludedFiles.has(path) || path.endsWith('.zip') || path.startsWith('reports/') || path.startsWith('.superpowers/')) {
    return false;
  }
  if (includedFiles.includes(path)) return true;
  if (path.startsWith('scripts/performance-diagnostics/')) return diagnosticKitExtensions.includes(extname(path));
  return includedRoots.some((root) => path.startsWith(root));
}

function parseStatusPaths(status) {
  const entries = status.split('\0');
  const paths = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined || entry.length < 4) continue;
    const statusCode = entry.slice(0, 2);
    const path = entry.slice(3);
    if (isDiagnosticSourcePath(path)) paths.add(path);
    if (statusCode.includes('R') || statusCode.includes('C')) {
      const originalPath = entries[index + 1];
      if (originalPath !== undefined && isDiagnosticSourcePath(originalPath)) paths.add(originalPath);
      index += 1;
    }
  }
  return [...paths].sort(compareStrings);
}

function validateRelativeSourcePath(path) {
  if (path.length === 0 || isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) {
    throw new Error('diagnostic_source_path_invalid');
  }
}

export async function diagnosticSourceFingerprint(repository, services = {}) {
  if (typeof repository !== 'string' || repository.length === 0 || !isAbsolute(repository)) {
    throw new Error('diagnostic_source_root_invalid');
  }
  const root = resolve(repository);
  if (await realpath(root) !== root) throw new Error('diagnostic_source_root_not_canonical');
  const executeGit = services.runGit ?? runGit;
  const [headOutput, filesOutput, ignoredFilesOutput, statusOutput] = await Promise.all([
    executeGit(['rev-parse', 'HEAD'], root),
    executeGit(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...sourcePathspecs], root),
    executeGit(['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...sourcePathspecs], root),
    executeGit(['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching', '-z', '--', ...sourcePathspecs], root),
  ]);
  if (filesOutput === null || ignoredFilesOutput === null || statusOutput === null) {
    throw new Error('diagnostic_source_inventory_unavailable');
  }

  const inventoryPaths = [...filesOutput.split('\0'), ...ignoredFilesOutput.split('\0')];
  const sourcePaths = [...new Set(inventoryPaths.filter(isDiagnosticSourcePath))].sort(compareStrings);
  if (sourcePaths.length === 0) throw new Error('diagnostic_source_inventory_empty');

  const hash = createHash('sha256');
  for (const path of sourcePaths) {
    validateRelativeSourcePath(path);
    const absolutePath = join(root, path);
    const fileHash = createHash('sha256');
    try {
      fileHash.update(await readFile(absolutePath));
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      fileHash.update('diagnostic_source_file_missing');
    }
    hash.update(path).update('\0').update(fileHash.digest()).update('\0');
  }

  return Object.freeze({
    commit: headOutput?.trim() || null,
    dirtySourcePaths: Object.freeze(parseStatusPaths(statusOutput)),
    digest: hash.digest('hex'),
  });
}
