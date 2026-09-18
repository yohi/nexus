export declare const EXPECTED_TOOL_NAMES: readonly string[];

export type VerificationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export interface ToolCallResult {
  readonly data: unknown;
  readonly marker?: string;
  readonly error?: string;
}

export declare const validateToolList: (actualNames: readonly string[]) => VerificationResult;
export declare const validateToolResult: (toolName: string, result: unknown, marker?: string) => VerificationResult;
export declare const summarizeToolResult: (phase: string, toolName: string, result: ToolCallResult) => Record<string, unknown>;
export declare const runVerification: (options?: { readonly cliPath?: string; readonly json?: boolean }) => Promise<Record<string, unknown>>;
