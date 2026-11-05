import { lstat, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Profile } from './contracts.js';
import { generateFixture } from './fixtures.js';
import { gitEnvironment, runGit } from './git-command.js';
import type { GitCommandContext, GitCommandResult, GitRunner } from './git-command.js';

export interface OwnedGitWorkspace {
  readonly root: string;
  readonly repositoryRoot: string;
  readonly dispose: () => Promise<void>;
}
const ownedRoots = new WeakSet<OwnedGitWorkspace>();
const sourceRepository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export class GitFixtureError extends Error {
  constructor(readonly code: 'git_workspace_not_owned' | 'git_ancestor_repository' | 'git_discovery_failed' |
    'git_repository_exists' | 'git_init_failed' | 'git_top_level_mismatch' | 'git_command_failed' |
    'git_hooks_configured' | 'git_template_configured' | 'git_cleanup_failed') { super(code); this.name = 'GitFixtureError'; }
}
const inside = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
};

export async function createOwnedGitWorkspace(): Promise<Readonly<OwnedGitWorkspace>> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nexus-performance-git-')));
  const repositoryRoot = join(root, 'repository');
  try { await mkdir(repositoryRoot); }
  catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  let disposal: Promise<void> | undefined;
  const workspace: OwnedGitWorkspace = { root, repositoryRoot,
    dispose: () => disposal ??= rm(root, { recursive: true, force: true }) };
  ownedRoots.add(workspace);
  return Object.freeze(workspace);
}

function success(result: GitCommandResult): boolean { return result.status === 'exited' && result.exitCode === 0; }

async function guardBeforeInit(workspace: OwnedGitWorkspace, run: GitRunner, context: GitCommandContext): Promise<void> {
  if (!ownedRoots.has(workspace) || await realpath(workspace.repositoryRoot) !== workspace.repositoryRoot ||
    !inside(workspace.root, workspace.repositoryRoot) || inside(await realpath(sourceRepository), workspace.repositoryRoot)) {
    throw new GitFixtureError('git_workspace_not_owned');
  }
  try { await lstat(join(workspace.repositoryRoot, '.git')); throw new GitFixtureError('git_repository_exists'); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const discovery = await run(['rev-parse', '--show-toplevel'], context);
  if (success(discovery)) throw new GitFixtureError('git_ancestor_repository');
  if (discovery.status !== 'exited' || discovery.exitCode !== 128 || !/fatal: not a git repository\b/.test(discovery.stderr)) {
    throw new GitFixtureError('git_discovery_failed');
  }
}

export async function createSiblingGitFixture(profile: Profile, signal: AbortSignal,
  dependencies: Readonly<{ workspace?: OwnedGitWorkspace; run?: GitRunner }> = {}) {
  const workspace = dependencies.workspace ?? await createOwnedGitWorkspace();
  if (!ownedRoots.has(workspace)) throw new GitFixtureError('git_workspace_not_owned');
  const run = dependencies.run ?? runGit;
  const env = gitEnvironment();
  const context = { cwd: workspace.repositoryRoot, env, signal };
  const peers: string[] = [];
  let disposing: Promise<void> | undefined;
  const dispose = () => disposing ??= (async () => {
    let failed = false;
    try {
      for (const path of peers.toReversed()) {
        if (!success(await run(['worktree', 'remove', path], { ...context, signal: new AbortController().signal }))) failed = true;
      }
    } finally { await workspace.dispose(); }
    if (failed) throw new GitFixtureError('git_cleanup_failed');
  })();
  try {
    const version = await run(['--version'], context);
    if (version.status === 'unavailable') { await workspace.dispose(); return { status: 'skipped' as const, reason: 'git_unavailable' as const }; }
    if (!success(version)) throw new GitFixtureError('git_command_failed');
    await guardBeforeInit(workspace, run, context);
    for (const [key, code] of [['core.hooksPath', 'git_hooks_configured'], ['init.templateDir', 'git_template_configured']] as const) {
      const configured = await run(['config', '--get', key], context);
      if (configured.status !== 'exited' || configured.exitCode !== 1) throw new GitFixtureError(code);
    }
    const configPath = join(workspace.root, 'git-config');
    await writeFile(configPath, '', 'utf8');
    context.env = { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: configPath, GIT_ATTR_NOSYSTEM: '1' };
    const identity = ['-c', 'user.name=Nexus Benchmark Fixture', '-c', 'user.email=benchmark@nexus.invalid',
      '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', `core.attributesFile=${configPath}`];
    const command = (args: readonly string[], input?: string) => run([...identity, ...args], { ...context, ...(input === undefined ? {} : { input }) });
    const manifest = await generateFixture(workspace.repositoryRoot, profile);
    if (!success(await command(['init', '--quiet', '--initial-branch=fixture']))) throw new GitFixtureError('git_init_failed');
    const top = await command(['rev-parse', '--show-toplevel']);
    if (!success(top) || await realpath(top.stdout.trim()) !== workspace.repositoryRoot) throw new GitFixtureError('git_top_level_mismatch');
    if (!success(await command(['add', '--pathspec-from-file=-', '--pathspec-file-nul'],
      `${manifest.files.map((file) => file.path).join('\0')}\0`))) throw new GitFixtureError('git_command_failed');
    if (!success(await command(['commit', '--quiet', '-m', 'Generated benchmark fixture']))) throw new GitFixtureError('git_command_failed');
    for (const role of ['first', 'second'] as const) {
      const path = join(workspace.root, role);
      await mkdir(path);
      if (!success(await command(['worktree', 'add', '--quiet', '--detach', path, 'HEAD']))) throw new GitFixtureError('git_command_failed');
      peers.push(path);
    }
    return { status: 'ready' as const, manifest,
      worktrees: Object.freeze(peers.map((root, index) => Object.freeze({ role: index === 0 ? 'first' as const : 'second' as const, root }))), dispose };
  } catch (error) {
    try { await dispose(); } catch { throw new GitFixtureError('git_cleanup_failed'); }
    throw error;
  }
}
