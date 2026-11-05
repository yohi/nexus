import { realpath } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOwnedGitWorkspace, createSiblingGitFixture } from '../../../benchmarks/performance/git-fixture.js';
import type { GitCommandContext, GitCommandResult } from '../../../benchmarks/performance/git-command.js';

const owned: Awaited<ReturnType<typeof createOwnedGitWorkspace>>[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const value of owned.splice(0)) await value.dispose(); });
const exited = (exitCode: number, stdout = '', stderr = ''): GitCommandResult => ({ status: 'exited', exitCode, stdout, stderr });

describe('disposable Git fixture ownership guards', () => {
  it('accepts expected pre-init non-repository discovery before init and verifies top level before writes', async () => {
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) vi.stubEnv(key, 'untrusted-selection');
    const workspace = await createOwnedGitWorkspace(); owned.push(workspace);
    const calls: string[][] = [];
    const run = (args: readonly string[], context: GitCommandContext): Promise<GitCommandResult> => {
      calls.push([...args]);
      expect(context.env.GIT_DIR).toBeUndefined();
      expect(context.env.GIT_WORK_TREE).toBeUndefined();
      expect(context.env.GIT_COMMON_DIR).toBeUndefined();
      expect(context.env.GIT_INDEX_FILE).toBeUndefined();
      expect(context.env.GIT_OBJECT_DIRECTORY).toBeUndefined();
      if (args.includes('--version')) return Promise.resolve(exited(0, 'git version fixture'));
      if (args.includes('config')) return Promise.resolve(exited(1));
      if (args.includes('rev-parse')) return Promise.resolve(calls.some((call) => call.includes('init'))
        ? exited(0, `${workspace.repositoryRoot}\n`) : exited(128, '', 'fatal: not a git repository (or any of the parent directories): .git'));
      return Promise.resolve(exited(0));
    };
    const result = await createSiblingGitFixture('smoke', new AbortController().signal, { workspace, run });
    expect(result.status).toBe('ready');
    const firstWrite = calls.findIndex((call) => call.includes('add'));
    const init = calls.findIndex((call) => call.includes('init'));
    const checks = calls.map((call, index) => call.includes('rev-parse') ? index : -1).filter((index) => index >= 0);
    expect(checks[0]).toBeLessThan(init);
    expect(checks[1]).toBeGreaterThan(init);
    expect(checks[1]).toBeLessThan(firstWrite);
    if (result.status === 'ready') await result.dispose();
  });

  it.each(['ancestor', 'discovery-error', 'init-failed', 'top-level-mismatch'] as const)(
    'never adds, commits or creates worktrees when %s guard fails', async (mode) => {
      const workspace = await createOwnedGitWorkspace(); owned.push(workspace);
      const calls: string[][] = [];
      let initialized = false;
      const run = async (args: readonly string[]): Promise<GitCommandResult> => {
        calls.push([...args]);
        if (args.includes('--version')) return exited(0, 'git version fixture');
        if (args.includes('config')) return exited(1);
        if (args.includes('init')) { initialized = true; return exited(mode === 'init-failed' ? 1 : 0); }
        if (args.includes('rev-parse')) {
          if (!initialized) return mode === 'ancestor' ? exited(0, `${await realpath(workspace.root)}\n`)
            : exited(128, '', mode === 'discovery-error' ? 'fatal: unrelated IO failure' : 'fatal: not a git repository');
          return exited(0, `${workspace.root}\n`);
        }
        return exited(0);
      };
      await expect(createSiblingGitFixture('smoke', new AbortController().signal, { workspace, run })).rejects.toThrow();
      expect(calls.some((call) => call.includes('add') || call.includes('commit') || call.includes('worktree'))).toBe(false);
    },
  );

  it('reports missing Git explicitly without pretending a sibling baseline ran', async () => {
    const workspace = await createOwnedGitWorkspace(); owned.push(workspace);
    const result = await createSiblingGitFixture('smoke', new AbortController().signal, { workspace,
      run: () => Promise.resolve({ status: 'unavailable', stdout: '', stderr: '' }) });
    expect(result).toMatchObject({ status: 'skipped', reason: 'git_unavailable' });
  });

  it('does not invoke cleanup supplied by a forged ownership record', async () => {
    const workspace = await createOwnedGitWorkspace(); owned.push(workspace);
    let cleaned = false;
    const forged = { ...workspace, dispose: () => { cleaned = true; return Promise.resolve(); } };
    await expect(createSiblingGitFixture('smoke', new AbortController().signal,
      { workspace: forged, run: () => Promise.resolve(exited(0)) })).rejects.toThrow('git_workspace_not_owned');
    expect(cleaned).toBe(false);
  });

  it('fails before init rather than bypass configured hooks', async () => {
    const workspace = await createOwnedGitWorkspace(); owned.push(workspace);
    const calls: string[][] = [];
    const run = (args: readonly string[]): Promise<GitCommandResult> => {
      calls.push([...args]);
      if (args.includes('--version')) return Promise.resolve(exited(0, 'git version fixture'));
      if (args.includes('rev-parse')) return Promise.resolve(exited(128, '', 'fatal: not a git repository'));
      if (args.includes('core.hooksPath')) return Promise.resolve(exited(0, 'configured-hooks'));
      return Promise.resolve(exited(0));
    };
    await expect(createSiblingGitFixture('smoke', new AbortController().signal, { workspace, run })).rejects.toThrow('git_hooks_configured');
    expect(calls.some((call) => call.includes('init') || call.includes('add') || call.includes('commit') || call.includes('worktree'))).toBe(false);
  });
});
