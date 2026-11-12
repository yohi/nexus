import { PassThrough, Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { lstat, mkdtemp, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChildProcess } from "node:child_process";
import {
  createProjectConnectorOptions,
  DEFAULT_BRIDGE_URL,
  type BridgeCliDependencies,
  type HttpBridgeOptions,
  parseBridgeArgs,
  resolveBridgeUrl,
  resolveNexusExecutable,
  runBridgeCli,
  runHttpBridgeWithSignalSource,
} from "../../../src/bin/http-bridge.js";
import { ensureProjectEndpoint, type SpawnFn } from "../../../src/server/project-connector.js";
import { writeProjectEndpoint } from "../../../src/server/project-endpoint.js";
import { admitStorageWriter, storageTargetsFingerprint } from "../../../src/server/storage-ownership/index.js";
import { testCoordinationRoot } from "../../shared/storage-ownership-coordination-setup.js";

class FakeTransport implements Transport {
  readonly sent: JSONRPCMessage[] = [];
  startCalls = 0;
  closeCalls = 0;
  terminateCalls = 0;
  callbacksInstalledAtStart = false;
  protocolVersion: string | undefined;
  startError: Error | undefined;
  sendError: Error | undefined;
  closeError: Error | undefined;
  onStart: (() => void) | undefined;
  onSend: ((message: JSONRPCMessage) => void) | undefined;
  onmessage: Transport["onmessage"];
  onerror: Transport["onerror"];
  onclose: Transport["onclose"];

  async start(): Promise<void> {
    this.startCalls += 1;
    this.callbacksInstalledAtStart =
      this.onmessage !== undefined && this.onerror !== undefined && this.onclose !== undefined;
    this.onStart?.();

    if (this.startError !== undefined) {
      throw this.startError;
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.sent.push(message);

    if (this.sendError !== undefined) {
      throw this.sendError;
    }

    this.onSend?.(message);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.onclose?.();

    if (this.closeError !== undefined) {
      throw this.closeError;
    }
  }

  async terminateSession(): Promise<void> {
    this.terminateCalls += 1;
  }

  emitMessage(message: JSONRPCMessage): void {
    this.onmessage?.(message);
  }

  emitError(error: Error): void {
    this.onerror?.(error);
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }
}

function createRequest(id: string | number, method: string): JSONRPCMessage {
  return { id, jsonrpc: "2.0", method };
}

function createResult(id: string | number, result: Record<string, unknown>): JSONRPCMessage {
  return { id, jsonrpc: "2.0", result };
}

function collectOutput(): { readonly stream: PassThrough; readonly text: () => string } {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on("data", (chunk: Buffer) => {
    chunks.push(chunk.toString("utf8"));
  });

  return { stream, text: () => chunks.join("") };
}

function createBridgeHarness(input: Readable, transport: FakeTransport, signalSource?: EventEmitter) {
  const output = collectOutput();
  const errorOutput = collectOutput();
  const options = {
    url: new URL(DEFAULT_BRIDGE_URL),
    input,
    output: output.stream,
    errorOutput: errorOutput.stream,
    createTransport: () => transport,
    signalSource: signalSource ?? new EventEmitter(),
  };

  return { errorOutput, options, output, signalSource: options.signalSource };
}

describe("http bridge", () => {
  describe("resolveBridgeUrl", () => {
    it("prefers the CLI URL over the environment URL", () => {
      const url = resolveBridgeUrl(
        "http://127.0.0.1:4100/mcp",
        "http://127.0.0.1:4200/mcp",
      );

      expect(url.href).toBe("http://127.0.0.1:4100/mcp");
    });

    it("uses the environment URL when no CLI URL is supplied", () => {
      const url = resolveBridgeUrl(undefined, "http://127.0.0.1:4200/mcp");

      expect(url.href).toBe("http://127.0.0.1:4200/mcp");
    });

    it("uses the loopback default when no override is supplied", () => {
      const url = resolveBridgeUrl(undefined, undefined);

      expect(DEFAULT_BRIDGE_URL).toBe("http://127.0.0.1:3001");
      expect(url.href).toBe("http://127.0.0.1:3001/");
    });

    it("rejects an invalid bridge URL", () => {
      expect(() => resolveBridgeUrl("not a URL", undefined)).toThrow(/Invalid bridge URL/);
    });
  });
  describe("resolveNexusExecutable", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "nexus-exec-"));
    });

    afterEach(async () => {
      await rm(tempDir, { force: true, recursive: true });
    });

    it("prefers the TypeScript entry when the bridge is a .ts file", async () => {
      const bridgeDir = join(tempDir, "src", "bin");
      await mkdir(bridgeDir, { recursive: true });
      await writeFile(join(bridgeDir, "http-bridge.ts"), "");
      await writeFile(join(bridgeDir, "nexus.ts"), "");

      const exec = resolveNexusExecutable(pathToFileURL(join(bridgeDir, "http-bridge.ts")).toString());
      expect(exec).toBe(join(bridgeDir, "nexus.ts"));
    });

    it("prefers the JavaScript entry when the bridge is a .js file", async () => {
      const bridgeDir = join(tempDir, "dist", "bin");
      await mkdir(bridgeDir, { recursive: true });
      await writeFile(join(bridgeDir, "http-bridge.js"), "");
      await writeFile(join(bridgeDir, "nexus.js"), "");

      const exec = resolveNexusExecutable(pathToFileURL(join(bridgeDir, "http-bridge.js")).toString());
      expect(exec).toBe(join(bridgeDir, "nexus.js"));
    });

    it("prefers the JavaScript entry when the bridge is a .ts file but no sibling nexus.ts exists", async () => {
      const bridgeDir = join(tempDir, "mixed", "bin");
      await mkdir(bridgeDir, { recursive: true });
      await writeFile(join(bridgeDir, "http-bridge.ts"), "");
      await writeFile(join(bridgeDir, "nexus.js"), "");

      const exec = resolveNexusExecutable(pathToFileURL(join(bridgeDir, "http-bridge.ts")).toString());
      expect(exec).toBe(join(bridgeDir, "nexus.js"));
    });

    it("throws when no sibling nexus entry exists", async () => {
      const bridgeDir = join(tempDir, "nowhere", "bin");
      await mkdir(bridgeDir, { recursive: true });
      await writeFile(join(bridgeDir, "http-bridge.js"), "");

      expect(() => resolveNexusExecutable(pathToFileURL(join(bridgeDir, "http-bridge.js")).toString())).toThrow(
        /Could not locate nexus executable/,
      );
    });
  });

  describe("runHttpBridge", () => {
    it("installs every transport callback before starting", async () => {
      const transport = new FakeTransport();
      const harness = createBridgeHarness(Readable.from([]), transport);

      await runHttpBridgeWithSignalSource(harness.options);

      expect(transport.callbacksInstalledAtStart).toBe(true);
    });

    it("forwards two messages in order and writes their responses", async () => {
      const first = createRequest(1, "ping");
      const second = createRequest(2, "tools/list");
      const transport = new FakeTransport();
      transport.onSend = (message) => {
        if ("id" in message && "method" in message) {
          transport.emitMessage(createResult(message.id, { method: message.method }));
        }
      };
      const harness = createBridgeHarness(
        Readable.from([`${JSON.stringify(first)}\n`, `${JSON.stringify(second)}\n`]),
        transport,
      );

      await runHttpBridgeWithSignalSource(harness.options);

      expect(transport.sent).toEqual([first, second]);
      expect(harness.output.text()).toBe(
        `${JSON.stringify(createResult(1, { method: "ping" }))}\n` +
          `${JSON.stringify(createResult(2, { method: "tools/list" }))}\n`,
      );
    });

    it("ignores blank input lines", async () => {
      const request = createRequest(1, "ping");
      const transport = new FakeTransport();
      const harness = createBridgeHarness(
        Readable.from(["\n", "  \n", `${JSON.stringify(request)}\n`, "\t\n"]),
        transport,
      );

      await runHttpBridgeWithSignalSource(harness.options);

      expect(transport.sent).toEqual([request]);
      expect(harness.output.text()).toBe("");
      expect(harness.errorOutput.text()).toBe("");
    });

    it("reports malformed input on stderr and continues with the next valid line", async () => {
      const request = createRequest(1, "ping");
      const transport = new FakeTransport();
      const harness = createBridgeHarness(
        Readable.from([
          "not valid JSON\n",
          `${JSON.stringify({ jsonrpc: "2.0", method: 42 })}\n`,
          `${JSON.stringify(request)}\n`,
        ]),
        transport,
      );

      await runHttpBridgeWithSignalSource(harness.options);

      expect(transport.sent).toEqual([request]);
      expect(harness.output.text()).toBe("");
      expect(harness.errorOutput.text()).toContain("Invalid JSON input");
      expect(harness.errorOutput.text()).toContain("Invalid JSON-RPC input");
    });

    it("sets the negotiated protocol version from the initialize response", async () => {
      const request = createRequest("initialize-1", "initialize");
      const transport = new FakeTransport();
      transport.onSend = (message) => {
        if ("id" in message && "method" in message) {
          transport.emitMessage(
            createResult(message.id, { protocolVersion: "2025-03-26" }),
          );
        }
      };
      const harness = createBridgeHarness(Readable.from([`${JSON.stringify(request)}\n`]), transport);

      await runHttpBridgeWithSignalSource(harness.options);

      expect(transport.protocolVersion).toBe("2025-03-26");
    });

    it("closes the transport once when input reaches EOF", async () => {
      const transport = new FakeTransport();
      const harness = createBridgeHarness(Readable.from([]), transport);

      await runHttpBridgeWithSignalSource(harness.options);

      expect(transport.closeCalls).toBe(1);
    });

    it.each(["SIGINT", "SIGTERM"] as const)(
      "closes the transport once when %s is emitted repeatedly",
      async (signal) => {
        const input = new PassThrough();
        const transport = new FakeTransport();
        const harness = createBridgeHarness(input, transport);
        transport.onStart = () => {
          harness.signalSource.emit(signal);
          harness.signalSource.emit(signal);
        };

        await runHttpBridgeWithSignalSource(harness.options);

        expect(transport.closeCalls).toBe(1);
      },
    );

    it("does not terminate the managed MCP session when SIGTERM is emitted", async () => {
      const input = new PassThrough();
      const transport = new FakeTransport();
      const harness = createBridgeHarness(input, transport);
      transport.onStart = () => {
        harness.signalSource.emit("SIGTERM");
      };

      await runHttpBridgeWithSignalSource(harness.options);

      expect(transport.terminateCalls).toBe(0);
      expect(transport.closeCalls).toBe(1);
    });

    it("propagates a start failure", async () => {
      const transport = new FakeTransport();
      transport.startError = new Error("connection failed");
      const harness = createBridgeHarness(Readable.from([]), transport);

      await expect(runHttpBridgeWithSignalSource(harness.options)).rejects.toThrow("connection failed");
      expect(transport.closeCalls).toBe(1);
    });

    it("stops after a send failure and closes the transport", async () => {
      const first = createRequest(1, "ping");
      const second = createRequest(2, "tools/list");
      const transport = new FakeTransport();
      transport.sendError = new Error("request failed");
      const harness = createBridgeHarness(
        Readable.from([`${JSON.stringify(first)}\n`, `${JSON.stringify(second)}\n`]),
        transport,
      );

      await expect(runHttpBridgeWithSignalSource(harness.options)).rejects.toThrow("request failed");
      expect(transport.sent).toEqual([first]);
      expect(transport.closeCalls).toBe(1);
    });

    it("surfaces a close failure once", async () => {
      const transport = new FakeTransport();
      transport.closeError = new Error("close failed");
      const harness = createBridgeHarness(Readable.from([]), transport);

      await expect(runHttpBridgeWithSignalSource(harness.options)).rejects.toThrow("close failed");
      expect(transport.closeCalls).toBe(1);
    });

    it("writes transport errors to stderr without contaminating stdout", async () => {
      const transport = new FakeTransport();
      transport.onStart = () => {
        transport.emitError(new Error("network disconnected"));
      };
      const harness = createBridgeHarness(Readable.from([]), transport);

      await runHttpBridgeWithSignalSource(harness.options);

      expect(harness.errorOutput.text()).toContain("network disconnected");
      expect(harness.output.text()).toBe("");
    });
  });

  describe("parseBridgeArgs", () => {
    it("uses the CLI URL over the environment URL", () => {
      const result = parseBridgeArgs(
        ["--url", "http://127.0.0.1:4100/mcp"],
        { NEXUS_BRIDGE_URL: "http://127.0.0.1:4200/mcp" },
      );

      expect(result.help).toBe(false);
      expect(result.url).toBe("http://127.0.0.1:4100/mcp");
    });

    it("uses the environment URL when no CLI URL is supplied", () => {
      const result = parseBridgeArgs(["--help"], {
        NEXUS_BRIDGE_URL: "http://127.0.0.1:4200/mcp",
      });

      expect(result.help).toBe(true);
      expect(result.url).toBe("http://127.0.0.1:4200/mcp");
    });

    it("uses the default URL when neither CLI nor environment URL is supplied", () => {
      const result = parseBridgeArgs([], {});

      expect(result.help).toBe(false);
      expect(result.url).toBeUndefined();
    });

    it("resolves the project root from CLI and environment", () => {
      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/cwd");

      const resultCli = parseBridgeArgs(["--project-root", "/cli"], {});
      expect(resultCli.projectRoot).toBe("/cli");

      const resultEnv = parseBridgeArgs([], { NEXUS_PROJECT_ROOT: "/env" });
      expect(resultEnv.projectRoot).toBe("/env");

      const resultDefault = parseBridgeArgs([], {});
      expect(resultDefault.projectRoot).toBe("/cwd");

      cwdSpy.mockRestore();
    });

    it("rejects unknown options under strict parsing", () => {
      expect(() =>
        parseBridgeArgs(["--unknown"], { NEXUS_BRIDGE_URL: undefined }),
      ).toThrow();
    });

    it("skips URL validation when --help is requested with an invalid URL", () => {
      const result = parseBridgeArgs(["--help", "--url", "not a URL"], {
        NEXUS_BRIDGE_URL: "also not a URL",
      });

      expect(result.help).toBe(true);
      expect(result.url).toBe("not a URL");
    });
  });

  describe("runBridgeCli", () => {
    it("uses project auto-discovery only when neither URL override is supplied", async () => {
      const ensureProjectEndpoint = vi.fn<(_options: { readonly projectRoot: string; readonly env: NodeJS.ProcessEnv }) => Promise<URL>>();
      const runHttpBridge = vi.fn<(_options: HttpBridgeOptions) => Promise<void>>();
      const bridgeStreams = {
        input: new PassThrough(),
        output: new PassThrough(),
        errorOutput: new PassThrough(),
      };
      const dependencies: BridgeCliDependencies = {
        ensureProjectEndpoint,
        runHttpBridge,
        bridgeStreams,
      };

      ensureProjectEndpoint.mockResolvedValue(new URL("http://127.0.0.1:44444"));

      await runBridgeCli([], {}, dependencies);

      expect(ensureProjectEndpoint).toHaveBeenCalledOnce();
      expect(runHttpBridge).toHaveBeenCalledOnce();
      expect(runHttpBridge.mock.calls[0]?.[0].url.href).toBe("http://127.0.0.1:44444/");
    });

    it("uses the CLI URL override and skips auto-discovery", async () => {
      const ensureProjectEndpoint = vi.fn<(_options: { readonly projectRoot: string; readonly env: NodeJS.ProcessEnv }) => Promise<URL>>();
      const runHttpBridge = vi.fn<(_options: HttpBridgeOptions) => Promise<void>>();
      const bridgeStreams = {
        input: new PassThrough(),
        output: new PassThrough(),
        errorOutput: new PassThrough(),
      };
      const dependencies: BridgeCliDependencies = {
        ensureProjectEndpoint,
        runHttpBridge,
        bridgeStreams,
      };

      await runBridgeCli(["--url", "http://127.0.0.1:55555"], {}, dependencies);

      expect(ensureProjectEndpoint).not.toHaveBeenCalled();
      expect(runHttpBridge).toHaveBeenCalledOnce();
      expect(runHttpBridge.mock.calls[0]?.[0].url.href).toBe("http://127.0.0.1:55555/");
    });

    it("uses the environment URL override and skips auto-discovery", async () => {
      const ensureProjectEndpoint = vi.fn<(_options: { readonly projectRoot: string; readonly env: NodeJS.ProcessEnv }) => Promise<URL>>();
      const runHttpBridge = vi.fn<(_options: HttpBridgeOptions) => Promise<void>>();
      const bridgeStreams = {
        input: new PassThrough(),
        output: new PassThrough(),
        errorOutput: new PassThrough(),
      };
      const dependencies: BridgeCliDependencies = {
        ensureProjectEndpoint,
        runHttpBridge,
        bridgeStreams,
      };

      await runBridgeCli([], { NEXUS_BRIDGE_URL: "http://127.0.0.1:3006" }, dependencies);

      expect(ensureProjectEndpoint).not.toHaveBeenCalled();
      expect(runHttpBridge).toHaveBeenCalledOnce();
      expect(runHttpBridge.mock.calls[0]?.[0].url.href).toBe("http://127.0.0.1:3006/");
    });

    it("prefers the CLI URL over the environment URL for manual override", async () => {
      const ensureProjectEndpoint = vi.fn<(_options: { readonly projectRoot: string; readonly env: NodeJS.ProcessEnv }) => Promise<URL>>();
      const runHttpBridge = vi.fn<(_options: HttpBridgeOptions) => Promise<void>>();
      const bridgeStreams = {
        input: new PassThrough(),
        output: new PassThrough(),
        errorOutput: new PassThrough(),
      };
      const dependencies: BridgeCliDependencies = {
        ensureProjectEndpoint,
        runHttpBridge,
        bridgeStreams,
      };

      await runBridgeCli(
        ["--url", "http://127.0.0.1:3007"],
        { NEXUS_BRIDGE_URL: "http://127.0.0.1:3008" },
        dependencies,
      );

      expect(ensureProjectEndpoint).not.toHaveBeenCalled();
      expect(runHttpBridge.mock.calls[0]?.[0].url.href).toBe("http://127.0.0.1:3007/");
    });

    it("passes the project root and environment to auto-discovery", async () => {
      const ensureProjectEndpoint = vi.fn<(_options: { readonly projectRoot: string; readonly env: NodeJS.ProcessEnv }) => Promise<URL>>();
      const runHttpBridge = vi.fn<(_options: HttpBridgeOptions) => Promise<void>>();
      const bridgeStreams = {
        input: new PassThrough(),
        output: new PassThrough(),
        errorOutput: new PassThrough(),
      };
      const dependencies: BridgeCliDependencies = {
        ensureProjectEndpoint,
        runHttpBridge,
        bridgeStreams,
      };

      ensureProjectEndpoint.mockResolvedValue(new URL("http://127.0.0.1:44444"));

      await runBridgeCli(["--project-root", "/my/project"], { NEXUS_FOO: "bar" }, dependencies);

      expect(ensureProjectEndpoint).toHaveBeenCalledWith({
        projectRoot: "/my/project",
        env: { NEXUS_FOO: "bar" },
      });
    });

    it("writes help to stderr and does not start the bridge", async () => {
      const ensureProjectEndpoint = vi.fn<(_options: { readonly projectRoot: string; readonly env: NodeJS.ProcessEnv }) => Promise<URL>>();
      const runHttpBridge = vi.fn<(_options: HttpBridgeOptions) => Promise<void>>();
      const errorOutput = new PassThrough();
      const chunks: Buffer[] = [];
      errorOutput.on("data", (chunk: Buffer) => chunks.push(chunk));
      const bridgeStreams = {
        input: new PassThrough(),
        output: new PassThrough(),
        errorOutput,
      };
      const dependencies: BridgeCliDependencies = {
        ensureProjectEndpoint,
        runHttpBridge,
        bridgeStreams,
      };

      await runBridgeCli(["--help"], {}, dependencies);

      expect(ensureProjectEndpoint).not.toHaveBeenCalled();
      expect(runHttpBridge).not.toHaveBeenCalled();
      expect(Buffer.concat(chunks).toString("utf8")).toContain("Nexus HTTP Bridge");
      expect(Buffer.concat(chunks).toString("utf8")).toContain(
        "Auto-discovers or starts the project-local managed endpoint",
      );
      expect(Buffer.concat(chunks).toString("utf8")).not.toContain(
        "default: http://127.0.0.1:3001",
      );
    });
  });

  // Nexus #297 (Design §4.4 F-001): discovery-only Bridge preflight over the full effective target set.
  describe("storage ownership discovery (Nexus #297)", () => {
    let projectRoot: string;

    beforeEach(async () => {
      projectRoot = await realpath(await mkdtemp(join(tmpdir(), "nexus-bridge-owner-")));
    });

    afterEach(async () => {
      await rm(projectRoot, { recursive: true, force: true });
    });

    const exists = async (path: string): Promise<boolean> => lstat(path).then(() => true, () => false);

    it("S13_bridge_passes_custom_metadata_and_vector_targets", async () => {
      const metadataDbPath = join(projectRoot, "custom-meta", "index.sqlite");
      const vectorDbPath = join(projectRoot, "custom-vectors");
      await writeFile(join(projectRoot, ".nexus.json"), JSON.stringify({ storage: { metadataDbPath } }));
      const spawnFn = vi.fn() as unknown as SpawnFn;
      const fetchFn = vi.fn<(url: string) => Promise<Response>>();

      const options = await createProjectConnectorOptions(
        projectRoot,
        { NEXUS_STORAGE_VECTOR_DB_PATH: vectorDbPath },
        { spawn: spawnFn, fetch: fetchFn, childExecutable: "/test/nexus.js" },
      );

      expect(options.storageDir).toBe(join(projectRoot, ".nexus"));
      expect(options.storageOwnershipTargets).toEqual({
        ownerProjectRoot: projectRoot,
        rootDir: { kind: "persistent", path: join(projectRoot, ".nexus") },
        metadataDbPath: { kind: "persistent", path: metadataDbPath },
        vectorDbPath: { kind: "persistent", path: vectorDbPath },
      });
      expect(options.childExecutable).toBe("/test/nexus.js");
      expect(options.spawn).toBe(spawnFn);

      const memory = await createProjectConnectorOptions(
        projectRoot,
        { NEXUS_STORAGE_VECTOR_DB_PATH: "memory://" },
        { spawn: spawnFn, fetch: fetchFn, childExecutable: "/test/nexus.js" },
      );
      expect(memory.storageOwnershipTargets.vectorDbPath).toEqual({ kind: "ephemeral", source: "memory://" });
      // Resolution is read-only: nothing was created for any target.
      for (const path of [join(projectRoot, ".nexus"), join(projectRoot, "custom-meta"), vectorDbPath]) {
        expect(await exists(path)).toBe(false);
      }
    });

    it("bridge_never_acquires_writer_lease", async () => {
      const writerDir = join(testCoordinationRoot(), "writer");
      const writerLocksBefore = await readdir(writerDir).catch(() => [] as string[]);
      let childAdmission: "admitted" | string | undefined;
      let options: Awaited<ReturnType<typeof createProjectConnectorOptions>> | undefined;
      const spawnFn: SpawnFn = () => {
        const child = new EventEmitter() as unknown as ChildProcess;
        (child as unknown as { unref: () => void }).unref = () => undefined;
        void (async () => {
          // A real child admission while the Bridge is mid-startup: it would fail with writer_busy if the Bridge
          // held any writer lease for these targets.
          try {
            const admission = await admitStorageWriter(options!.storageOwnershipTargets);
            childAdmission = "admitted";
            await writeProjectEndpoint(options!.storageDir, {
              instanceId: "child", pid: process.pid, projectRoot, url: "http://127.0.0.1:43999",
              storageTargetsFingerprint: storageTargetsFingerprint(options!.storageOwnershipTargets),
            });
            await admission.release();
          } catch (error) {
            childAdmission = (error as { code?: string }).code ?? String(error);
          }
        })();
        return child;
      };
      const fetchFn = async (): Promise<Response> =>
        new Response(JSON.stringify({ instanceId: "child", projectRoot }), { status: 200 });
      options = await createProjectConnectorOptions(projectRoot, {}, {
        spawn: spawnFn, fetch: fetchFn, childExecutable: "/test/nexus.js", startupTimeoutMs: 5_000, pollIntervalMs: 20,
      });

      const url = await ensureProjectEndpoint(options);

      expect(childAdmission).toBe("admitted");
      expect(url.port).toBe("43999");
      // The only writer lease files are the child's own three target keys; the Bridge added none of its own.
      const added = (await readdir(writerDir)).filter((name) => !writerLocksBefore.includes(name) && name.endsWith(".lock"));
      expect(added).toHaveLength(3);
      // After the child released, the Bridge holds nothing either: a fresh admission succeeds immediately.
      const again = await admitStorageWriter(options.storageOwnershipTargets);
      await again.release();
    });
  });
});
