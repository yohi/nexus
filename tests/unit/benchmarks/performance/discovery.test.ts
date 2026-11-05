import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));
async function discover(mode: 'test' | 'benchmark', config: string, e2e: boolean): Promise<string[]> {
  const source = `import {createVitest} from 'vitest/node';import{relative,sep}from'node:path';const runner=await createVitest(${JSON.stringify(mode)},
    {config:${JSON.stringify(config)},watch:false,run:true});try{const files=await runner.globTestSpecifications();
    process.stdout.write(JSON.stringify(files.map(file=>relative(process.cwd(),file.moduleId).split(sep).join('/'))))}finally{await runner.close()}`;
  const output = await new Promise<string>((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e', source],
    { cwd: repository, env: { ...process.env, NEXUS_E2E: e2e ? '1' : '0' }, encoding: 'utf8', timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => error === null ? resolve(stdout)
      : reject(error instanceof Error ? error : new Error('discovery_failed'))));
  return z.array(z.string()).parse(JSON.parse(output));
}

describe('real Vitest discovery boundaries', () => {
  it('isolates normal, E2E, microbench and performance files under both E2E environment states', async () => {
    const normal = await discover('test', 'vitest.config.ts', false);
    const e2e = await discover('test', 'vitest.config.ts', true);
    const bench = await discover('benchmark', 'vitest.config.ts', false);
    const perf = await discover('test', 'vitest.performance.config.ts', false);
    const perfE2e = await discover('test', 'vitest.performance.config.ts', true);
    expect(normal.length).toBeGreaterThan(0);
    expect(normal.every((file) => file.endsWith('.test.ts') && !file.startsWith('tests/e2e/'))).toBe(true);
    expect(e2e.length).toBeGreaterThan(0);
    expect(e2e.every((file) => file.startsWith('tests/e2e/') && file.endsWith('.test.ts'))).toBe(true);
    expect(bench.length).toBeGreaterThan(0);
    expect(bench.every((file) => file.endsWith('.bench.ts'))).toBe(true);
    expect(perf).toEqual(['tests/benchmarks/performance/runtime.perf.ts']);
    expect(perfE2e).toEqual(perf);
    expect(perf).not.toContain('tests/fixtures/performance/outside.perf.ts');
    expect([...normal, ...e2e, ...bench].some((file) => file.endsWith('.perf.ts'))).toBe(false);
    expect([...normal, ...e2e, ...perf].some((file) => file.endsWith('.bench.ts'))).toBe(false);
  });

  it('exposes an explicit performance lint gate for helpers, tests, config and parent JavaScript', async () => {
    const value: unknown = JSON.parse(await readFile(new URL('../../../../package.json', import.meta.url), 'utf8'));
    expect(z.object({ scripts: z.object({ 'lint:perf': z.string().min(1) }) }).safeParse(value).success).toBe(true);
  });
});
