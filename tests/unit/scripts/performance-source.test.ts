import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

const runFile = promisify(execFile);
const roots: string[] = [];
const script = fileURLToPath(new URL('../../../scripts/performance-source.mjs', import.meta.url));
const metadataSchema = z.object({ environment: z.object({ sourceFingerprint: z.string().optional() }) });

async function metadata(repository: string) {
  const { stdout } = await runFile(process.execPath, ['--input-type=module', '-e',
    `import(${JSON.stringify(pathToFileURL(script).href)}).then(async ({ performanceSourceMetadata }) => console.log(JSON.stringify(await performanceSourceMetadata(${JSON.stringify(repository)}))))`]);
  return metadataSchema.parse(JSON.parse(stdout));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('performanceSourceMetadata', () => {
  it('fingerprints a tracked source file deleted from the worktree deterministically', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'nexus-performance-source-'));
    roots.push(repository);
    await runFile('git', ['init', '--quiet'], { cwd: repository });
    await runFile('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repository });
    await runFile('git', ['config', 'user.name', 'Test'], { cwd: repository });
    await mkdir(join(repository, 'src'));
    await writeFile(join(repository, 'src', 'removed.ts'), 'export const removed = true;\n');
    await runFile('git', ['add', 'src/removed.ts'], { cwd: repository });
    await runFile('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: repository });
    await rm(join(repository, 'src', 'removed.ts'));

    const first = await metadata(repository);
    const second = await metadata(repository);

    expect(first.environment.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(second.environment.sourceFingerprint).toBe(first.environment.sourceFingerprint);
  });
});
