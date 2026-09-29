import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function makeTempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "nexus-dashboard-test-"));
}

export async function cleanupTempProject(projectRoot: string): Promise<void> {
  await rm(projectRoot, { recursive: true, force: true });
}

export interface TestNexusServer {
  metricsPort: number;
  close(): Promise<void>;
}

export async function startNexusServer(
  projectRoot: string,
  options: { preferredPort?: number } = {},
): Promise<TestNexusServer> {
  const proc = spawn(process.execPath, [
    join(__dirname, "../../../../dist/bin/nexus.js"),
    "--project-root", projectRoot,
  ], {
    env: {
      ...process.env,
      PATH: "/usr/bin:/bin",
      NEXUS_METRICS_PORT: String(options.preferredPort ?? 0),
    },
  });
  const portFile = join(projectRoot, ".nexus", "metrics.port");
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    try {
      const content = await readFile(portFile, "utf8");
      const port = Number.parseInt(content.trim(), 10);
      if (Number.isInteger(port) && port > 0) {
        return {
          metricsPort: port,
          close: () => new Promise<void>((resolve, reject) => {
            proc.once("error", reject);
            proc.once("close", () => resolve());
            proc.kill("SIGTERM");
            setTimeout(() => proc.kill("SIGKILL"), 5000).unref();
          }),
        };
      }
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
    }
    if (proc.exitCode !== null) {
      throw new Error("Nexus server exited before metrics.port was written");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  proc.kill("SIGTERM");
  throw new Error("Timed out waiting for metrics.port");
}

export function waitForOutput(
  getOutput: () => string,
  expected: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (getOutput().includes(expected)) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timeout waiting for output: ${expected}`));
      }
    }, 100);
  });
}
