export type DiagnosticVitestBootstrapInput = Readonly<{
  environment: Record<string, string | undefined>;
  repository: string;
  pid: number;
  preloadPath: string;
  configPath: string;
  testEntryPath: string;
}>;

export type DiagnosticVitestBootstrapServices = Readonly<{
  loadProfiler?: (preloadPath: string) => void | Promise<void>;
  startVitest?: (
    mode: 'test',
    filters: readonly string[],
    options: Readonly<Record<string, unknown>>,
  ) => Promise<unknown>;
  getExitCode?: () => number | null | undefined;
}>;

export type DiagnosticVitestBootstrapResult = Readonly<{
  status: 'completed' | 'failed';
  runId: string;
  profileRequestFile: string;
  statusFile: string;
  exitCode: number;
}>;

export class DiagnosticBootstrapError extends Error {
  readonly code: string;
  constructor(code: string);
}

export function runDiagnosticVitestBootstrap(
  input: DiagnosticVitestBootstrapInput,
  services?: DiagnosticVitestBootstrapServices,
): Promise<DiagnosticVitestBootstrapResult>;
