import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';

function command(file, args, cwd) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return new Promise((resolve) => execFile(file, args, { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    (error, stdout) => resolve(error === null ? stdout : null)));
}

export async function performanceSourceMetadata(repository) {
  const head = await command('git', ['rev-parse', 'HEAD'], repository);
  const status = await command('git', ['status', '--porcelain', '-uall'], repository);
  const rg = await command('rg', ['--version'], repository);
  const git = await command('git', ['--version'], repository);
  let lockfileDigest;
  const dependencies = {};
  try {
    const bytes = await readFile(join(repository, 'package-lock.json'));
    lockfileDigest = createHash('sha256').update(bytes).digest('hex');
    const lock = JSON.parse(bytes.toString('utf8'));
    for (const name of ['@lancedb/lancedb', 'typescript', 'zod', 'vitest', '@modelcontextprotocol/sdk']) {
      const version = lock.packages?.[`node_modules/${name}`]?.version;
      if (typeof version === 'string') dependencies[name] = version;
    }
  } catch { lockfileDigest = undefined; }
  let sourceFingerprint;
  const files = await command('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], repository);
  if (files !== null) {
    const hash = createHash('sha256');
    for (const path of [...new Set(files.split('\0').filter((path) => path.startsWith('src/') ||
      path.startsWith('tests/benchmarks/performance/') || /^scripts\/(?:run-performance|performance-).*\.mjs$/.test(path) ||
      ['package.json', 'package-lock.json', 'tsconfig.json', 'vitest.performance.config.ts'].includes(path)))].sort()) {
      hash.update(path).update('\0').update(createHash('sha256').update(await readFile(join(repository, path))).digest()).update('\0');
    }
    sourceFingerprint = hash.digest('hex');
  }
  return {
    revision: { commit: head?.trim() ?? null, dirty: status === null ? null : status.length > 0 },
    environment: { node: process.version, os: `${platform()} ${release()}`, architecture: arch(),
      cpuModel: cpus()[0]?.model ?? 'unavailable', cpuCount: cpus().length, memoryBytes: totalmem(),
      rgVersion: rg?.split('\n')[0] ?? null, gitVersion: git?.trim() ?? null, osCache: 'uncontrolled', dependencies,
      ...(lockfileDigest === undefined ? {} : { lockfileDigest }), ...(sourceFingerprint === undefined ? {} : { sourceFingerprint }) },
  };
}
