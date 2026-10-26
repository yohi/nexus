import { execFile } from 'node:child_process';

export interface GitCommandContext {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly input?: string;
}
export type GitCommandResult = Readonly<
  | { status: 'exited'; exitCode: number; stdout: string; stderr: string }
  | { status: 'unavailable'; stdout: string; stderr: string }
  | { status: 'failed'; code: 'git_aborted' | 'git_command_failed' | 'git_stdin_failed'; stdout: string; stderr: string }
>;
export type GitRunner = (args: readonly string[], context: Readonly<GitCommandContext>) => Promise<GitCommandResult>;

export const runGit: GitRunner = (args, context) => new Promise((resolve) => {
  let inputFailed = false;
  const child = execFile('git', args, { cwd: context.cwd, env: context.env, signal: context.signal,
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (context.signal.aborted) resolve({ status: 'failed', code: 'git_aborted', stdout, stderr });
    else if (inputFailed) resolve({ status: 'failed', code: 'git_stdin_failed', stdout, stderr });
    else if (error === null) resolve({ status: 'exited', exitCode: 0, stdout, stderr });
    else if (error.code === 'ENOENT') resolve({ status: 'unavailable', stdout, stderr });
    else if (typeof error.code === 'number') resolve({ status: 'exited', exitCode: error.code, stdout, stderr });
    else resolve({ status: 'failed', code: 'git_command_failed', stdout, stderr });
  });
  child.stdin?.on('error', () => { inputFailed = true; });
  child.stdin?.end(context.input);
});

export function gitEnvironment(): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), LC_ALL: 'C' };
}
