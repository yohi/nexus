import { spawn } from 'node:child_process';
import { RipgrepEngine } from '../../search/grep.js';
import type { GrepMatch } from '../../types/index.js';
import { z } from 'zod';
import { emitRuntimeEvent } from '../../observability/runtime-observer.js';
import type { GrepChildOutcome, RuntimeObserver } from '../../observability/runtime-observer.js';
import { startRuntimeWork } from '../../observability/runtime-work.js';

interface RipgrepMatchData {
  type: 'match' | 'begin' | 'end' | 'summary';
  data: { path: { text: string }; line_number: number; lines: { text: string };
    submatches: Array<{ start: number; end: number; match: { text: string } }> };
}

const matchSchema = z.object({ type: z.literal('match'), data: z.object({
  path: z.object({ text: z.string() }), line_number: z.number().int().positive(),
  lines: z.object({ text: z.string() }),
  submatches: z.array(z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative(),
    match: z.object({ text: z.string() }) }).refine((match) => match.end >= match.start)),
}) });

export function parseGrepOutput(stdout: string, observer?: RuntimeObserver): GrepMatch[] {
  return stdout.split('\n').filter((line) => line.trim() !== '').map((line) => {
    try {
      const parsed = JSON.parse(line) as RipgrepMatchData;
      if (parsed.type !== 'match') return null;
      if (observer !== undefined && !matchSchema.safeParse(parsed).success) emitRuntimeEvent(observer, { kind: 'grep_invalid_match' });
      return {
        filePath: parsed.data.path.text, lineNumber: parsed.data.line_number,
        lineText: parsed.data.lines.text,
        submatches: parsed.data.submatches.map((match) => ({
          start: match.start, end: match.end, match: match.match.text,
        })),
      };
    } catch {
      emitRuntimeEvent(observer, { kind: 'grep_invalid_match' });
      return null;
    }
  }).filter((match): match is GrepMatch => match !== null);
}

export function createGrepEngine(projectRoot: string, observer?: RuntimeObserver): RipgrepEngine {
  return new RipgrepEngine({
    projectRoot, observer,
    spawn: (params, signal) => {
      const scope = observer === undefined ? undefined : startRuntimeWork(observer, 'grep_spawn');
      const run = () => new Promise<GrepMatch[]>((res, rej) => {
      const args = ['--json', ...(params.caseSensitive ? [] : ['--ignore-case'])];
      if (params.glob?.length) params.glob.forEach((glob) => args.push('--glob', glob));
      args.push('--', params.query, params.cwd);
      const child = spawn('rg', args, { signal });
      let childFailure: GrepChildOutcome | undefined;
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (data: Buffer | string) => { stdout += data.toString(); });
      child.stderr.on('data', (data: Buffer | string) => { stderr += data.toString(); });
      child.on('close', (code, exitSignal) => {
        const outcome: GrepChildOutcome = childFailure ?? (exitSignal !== null
          ? { status: 'signal_termination', signal: exitSignal }
          : code === 0 || code === 1 ? { status: 'exited', exitCode: code }
            : { status: 'failed_exit', exitCode: code ?? -1 });
        scope?.emit({ kind: 'grep_child_finished', outcome });
        if (code !== 0 && code !== 1) {
          scope?.finish(outcome.status === 'aborted' ? 'aborted' : 'failed');
          rej(new Error(`ripgrep failed: ${stderr}`)); return;
        }
        const matches = parseGrepOutput(stdout, observer);
        scope?.finish(outcome.status === 'exited' ? 'success' : 'failed');
        res(matches);
      });
      child.on('error', (error) => {
        childFailure = { status: error.name === 'AbortError' ? 'aborted' : 'spawn_failure' };
        if (error.name === 'AbortError') res([]); else rej(error);
      });
      });
      return scope === undefined ? run() : scope.run(run);
    },
  });
}
