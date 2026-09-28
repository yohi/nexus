import { describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { makeTempProject, cleanupTempProject, startNexusServer, waitForOutput } from "./helpers.js";

const workspaceCliPath = path.resolve("packages/dashboard/dist/cli.js");
const cliPath = existsSync(workspaceCliPath) ? workspaceCliPath : path.resolve("dist/cli.js");

async function stopProcess(proc: ChildProcess | undefined): Promise<void> {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => proc.once("close", () => resolve()));
  proc.kill("SIGKILL");
  await closed;
}

describe("nexus dashboard integration", () => {
  it("starts and shows Runtime unavailable when the server is not running", async () => {
    const projectRoot = await makeTempProject();
    let proc: ChildProcess | undefined;
    try {
      proc = spawn("node", [cliPath, "--project-root", projectRoot], {
        cwd: process.cwd(),
        env: { ...process.env, FORCE_COLOR: "0" },
      });

      let output = "";
      proc.stdout?.on("data", (chunk) => { output += chunk.toString(); });
      proc.stderr?.on("data", (chunk) => { output += chunk.toString(); });

      await waitForOutput(() => output, "Runtime unavailable", 15_000);
      proc.kill("SIGTERM");
      const [exitCode, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
        proc?.once("close", (code, receivedSignal) => resolve([code, receivedSignal])),
      );
      expect(output).toContain("Runtime unavailable");
      expect(exitCode).toBeNull();
      expect(signal).toBe("SIGTERM");
    } finally {
      await stopProcess(proc);
      await cleanupTempProject(projectRoot);
    }
  }, 40_000);

  it("reconnects after the runtime restarts on a changed port", async () => {
    const projectRoot = await makeTempProject();
    let firstServer: Awaited<ReturnType<typeof startNexusServer>> | undefined;
    let secondServer: Awaited<ReturnType<typeof startNexusServer>> | undefined;
    let proc: ChildProcess | undefined;
    try {
      firstServer = await startNexusServer(projectRoot);
      const firstPort = firstServer.metricsPort;
      await firstServer.close();
      firstServer = undefined;

      proc = spawn("node", [cliPath, "--project-root", projectRoot], {
        cwd: process.cwd(),
        env: { ...process.env, FORCE_COLOR: "0" },
      });

      let output = "";
      proc.stdout?.on("data", (chunk) => { output += chunk.toString(); });
      proc.stderr?.on("data", (chunk) => { output += chunk.toString(); });

      await waitForOutput(() => output, "Runtime unavailable", 15_000);

      secondServer = await startNexusServer(projectRoot, { preferredPort: firstPort + 1 });
      await waitForOutput(() => output, "No active issues", 15000);

      proc.kill("SIGTERM");
      const [exitCode, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
        proc?.once("close", (code, receivedSignal) => resolve([code, receivedSignal])),
      );
      expect(output).toContain("No active issues");
      expect(exitCode).toBeNull();
      expect(signal).toBe("SIGTERM");
    } finally {
      await stopProcess(proc);
      await secondServer?.close();
      await firstServer?.close();
      await cleanupTempProject(projectRoot);
    }
  }, 40_000);
});
