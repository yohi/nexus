import { runRuntimeDiagnosticStage } from '../../../src/observability/diagnostic-stage-trace.js';

export interface WorkerCleanupArtifacts {
  readonly closeRuntime?: () => Promise<void>;
  readonly disposeTarget?: () => Promise<void>;
  readonly removeWorkspace?: () => Promise<void>;
}

export async function cleanupWorkerArtifacts(artifacts: WorkerCleanupArtifacts): Promise<void> {
  if (artifacts.closeRuntime !== undefined) {
    await runRuntimeDiagnosticStage('S12_resource_cleanup', artifacts.closeRuntime);
  }
  if (artifacts.disposeTarget !== undefined) {
    await runRuntimeDiagnosticStage('S12_resource_cleanup', artifacts.disposeTarget);
  }
  if (artifacts.removeWorkspace !== undefined) {
    await runRuntimeDiagnosticStage('S12_resource_cleanup', artifacts.removeWorkspace);
  }
}
