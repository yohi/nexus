export type DiagnosticSourceFingerprint = Readonly<{
  commit: string | null;
  dirtySourcePaths: readonly string[];
  digest: string;
}>;

export type DiagnosticSourceServices = Readonly<{
  runGit?: (args: readonly string[], cwd: string) => Promise<string | null>;
}>;

export function diagnosticSourceFingerprint(
  repository: string,
  services?: DiagnosticSourceServices,
): Promise<DiagnosticSourceFingerprint>;
