import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { makeTempProject, cleanupTempProject, startNexusServer, waitForOutput } from "./helpers.js";

const cliPath = path.resolve("dist/cli.js");

describe("nexus dashboard integration", () => {
  it("starts and shows Runtime unavailable when the server is not running", async () => {
    const projectRoot = await makeTempProject();
    const proc = spawn("node", [cliPath, "--project-root", projectRoot], {
      cwd: process.cwd(),
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    let output = "";
    proc.stdout.on("data", (chunk) => { output += chunk.toString(); });
    proc.stderr.on("data", (chunk) => { output += chunk.toString(); });

    await waitForOutput(() => output, "Runtime unavailable", 5000);
    proc.kill("SIGTERM");
    const [exitCode, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
      proc.once("close", (code, receivedSignal) => resolve([code, receivedSignal])),
    );
    expect(output).toContain("Runtime unavailable");
    expect(exitCode).toBeNull();
    expect(signal).toBe("SIGTERM");
  });

  it("reconnects after the runtime restarts on a changed port", async () => {
    const projectRoot = await makeTempProject();
    const firstServer = await startNexusServer(projectRoot);
    const firstPort = firstServer.metricsPort;
    await firstServer.close();

    const proc = spawn("node", [cliPath, "--project-root", projectRoot], {
      cwd: process.cwd(),
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    let output = "";
    proc.stdout.on("data", (chunk) => { output += chunk.toString(); });
    proc.stderr.on("data", (chunk) => { output += chunk.toString(); });

    await waitForOutput(() => output, "Runtime unavailable", 5000);

    const secondServer = await startNexusServer(projectRoot, { preferredPort: firstPort + 1 });
    await waitForOutput(() => output, "No active issues", 15000);

    proc.kill("SIGTERM");
    const [exitCode, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
      proc.once("close", (code, receivedSignal) => resolve([code, receivedSignal])),
    );
    expect(output).toContain("No active issues");
    expect(exitCode).toBeNull();
    expect(signal).toBe("SIGTERM");
    await secondServer.close();
    await cleanupTempProject(projectRoot);
  }, 40_000);
});
