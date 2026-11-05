import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod';

it('preserves_write_and_lock_identity_failures_when_cleanup_detects_replaced_lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-profile-budget-replaced-lock-'));
  const runDirectory = join(root, 'run');
  const profileDirectory = join(runDirectory, 'profiles');
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  const modulePath = join(process.cwd(), 'scripts/performance-diagnostics/v4/profile-run-budget.cjs');
  const script = [
    "const fs = require('node:fs');",
    `const runDirectory = ${JSON.stringify(runDirectory)};`,
    `const profileDirectory = ${JSON.stringify(profileDirectory)};`,
    `const modulePath = ${JSON.stringify(modulePath)};`,
    "const { withProfileRunBudget } = require(modulePath);",
    "const runFd = fs.openSync(runDirectory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);",
    "const profileFd = fs.openSync(profileDirectory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);",
    "let observed;",
    "try {",
    "  withProfileRunBudget(runFd, profileFd, 1, () => {",
    "    const lockPath = '/proc/self/fd/' + runFd + '/profile-budget.lock';",
    "    fs.unlinkSync(lockPath);",
    "    fs.writeFileSync(lockPath, 'replacement', { flag: 'wx', mode: 0o600 });",
    "    throw new Error('operation_failed');",
    "  });",
    "} catch (error) {",
    "  observed = { name: error.name, message: error.message, code: error.code,",
    "    errors: error instanceof AggregateError ? error.errors.map((cause) => cause.message) : [],",
    "    replacement: fs.readFileSync('/proc/self/fd/' + runFd + '/profile-budget.lock', 'utf8') };",
    "} finally { fs.closeSync(profileFd); fs.closeSync(runFd); }",
    "process.stdout.write(JSON.stringify(observed));",
  ].join('\n');

  try {
  const output = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    const when = z.object({
      name: z.string(),
      message: z.string(),
      code: z.string().optional(),
      errors: z.array(z.string()),
      replacement: z.string(),
    }).strict().parse(JSON.parse(output));

    expect(when.name).toBe('AggregateError');
    expect(when.message).toBe('profile_budget_lock_cleanup_failed');
    expect(when.code).toBe('profile_budget_lock_cleanup_failed');
    expect(when.errors).toContain('operation_failed');
    expect(when.errors).toContain('profile_budget_lock_replaced');
    expect(when.replacement).toBe('replacement');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
