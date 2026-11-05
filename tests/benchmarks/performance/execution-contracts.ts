import { z } from 'zod';

export const effectiveLimitSchema = z.object({ stage: z.enum(['grep', 'fusion', 'semantic', 'context']),
  behavior: z.enum(['uncapped', 'top_k', 'token_budget']), maximum: z.number().int().positive().optional(),
}).strict().readonly();
export const queryMetadataSchema = z.object({ tool: z.enum(['grep_search', 'semantic_search', 'hybrid_search',
  'get_file_outline', 'get_symbol_source', 'get_symbol_context']), requestedMaximum: z.number().int().positive(),
  limits: z.array(effectiveLimitSchema).readonly() }).strict().readonly();
export const grepExecutionSchema = z.object({ wallMs: z.number().finite().nonnegative(),
  outcome: z.enum(['exit_0', 'exit_1', 'failed_exit', 'signal_termination', 'aborted', 'timeout', 'spawn_failure', 'parser_failure']),
  exitCode: z.number().int().nullable(), measurement: z.literal('observed_child_wall_not_cpu'),
}).strict().readonly();
export type GrepExecution = z.infer<typeof grepExecutionSchema>;
