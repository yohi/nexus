import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquireProcessLock: vi.fn(),
  admitStorageWriter: vi.fn(),
  releaseOwnedProcessLock: vi.fn(),
  releaseOwnedProcessLockSync: vi.fn(),
  resolveStorageOwnershipTargets: vi.fn(),
  createHttpServer: vi.fn(),
  createRestApiHandler: vi.fn(),
  createRuntime: vi.fn(),
  createStreamableHttpHandler: vi.fn(),
  dashboardMain: vi.fn(),
  loadConfig: vi.fn(),
  releaseProcessLock: vi.fn(),
  readIndexProgress: vi.fn(),
  startManagedHttpServer: vi.fn(),
}));

vi.mock("node:http", () => ({
  createServer: mocks.createHttpServer,
}));

vi.mock("../../../src/config/index.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../../../src/server/factory.js", () => ({
  NexusServerFactory: { createRuntime: mocks.createRuntime },
}));

vi.mock("../../../src/server/transport.js", () => ({
  createStreamableHttpHandler: mocks.createStreamableHttpHandler,
}));

vi.mock("../../../src/server/rest-api.js", () => ({
  createRestApiHandler: mocks.createRestApiHandler,
}));

vi.mock("../../../src/server/process-lock.js", () => ({
  acquireProcessLock: mocks.acquireProcessLock,
  releaseProcessLock: mocks.releaseProcessLock,
  releaseOwnedProcessLock: mocks.releaseOwnedProcessLock,
  releaseOwnedProcessLockSync: mocks.releaseOwnedProcessLockSync,
  LOCK_FILENAME: "nexus.pid",
}));

vi.mock("../../../src/server/storage-ownership/index.js", () => ({
  admitStorageWriter: mocks.admitStorageWriter,
  resolveStorageOwnershipTargets: mocks.resolveStorageOwnershipTargets,
}));

vi.mock("../../../src/bin/index-progress.js", () => ({
  readIndexProgress: mocks.readIndexProgress,
}));

vi.mock("../../../src/server/managed-http-server.js", () => ({
  startManagedHttpServer: mocks.startManagedHttpServer,
}));

const originalArgv = [...process.argv];
const originalExitDescriptor = Object.getOwnPropertyDescriptor(process, "exit");
type RawProcessListener = ReturnType<typeof process.rawListeners>[number];
let initialSigintListeners: Set<RawProcessListener>;
let initialSigtermListeners: Set<RawProcessListener>;

let admission: { release: ReturnType<typeof vi.fn> };

const config = {
  projectRoot: "/project",
  storage: { rootDir: "/storage" },
};

async function importCliAndGetShutdownHandler(args: readonly string[]): Promise<RawProcessListener> {
  const existingListeners = new Set(process.rawListeners("SIGTERM"));
  process.argv = [originalArgv[0] ?? "node", originalArgv[1] ?? "nexus", ...args];

  await import("../../../src/bin/nexus.js");

  await vi.waitFor(() => {
    expect(process.rawListeners("SIGTERM").some((listener) => !existingListeners.has(listener))).toBe(true);
  });

  const shutdownHandler = process
    .rawListeners("SIGTERM")
    .find((listener) => !existingListeners.has(listener));
  if (shutdownHandler === undefined) {
    throw new Error("Expected Nexus to register a SIGTERM handler");
  }
  return shutdownHandler;
}

describe("nexus CLI shutdown", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    initialSigintListeners = new Set(process.rawListeners("SIGINT"));
    initialSigtermListeners = new Set(process.rawListeners("SIGTERM"));
    Object.defineProperty(process, "exit", {
      configurable: true,
      value: vi.fn(),
    });
    mocks.acquireProcessLock.mockResolvedValue({ acquired: true });
    mocks.resolveStorageOwnershipTargets.mockResolvedValue({ ownerProjectRoot: "/project" });
    admission = { release: vi.fn(async () => {}) };
    mocks.admitStorageWriter.mockResolvedValue(admission);
    mocks.releaseOwnedProcessLock.mockResolvedValue(undefined);
    mocks.releaseProcessLock.mockResolvedValue(undefined);
    mocks.readIndexProgress.mockResolvedValue(undefined);
    mocks.loadConfig.mockResolvedValue(config);
    mocks.createRestApiHandler.mockReturnValue(vi.fn(async () => {}));
  });

  afterEach(() => {
    for (const listener of process.rawListeners("SIGINT")) {
      if (!initialSigintListeners.has(listener)) {
        Reflect.apply(listener, process, ["SIGINT"]);
      }
    }
    for (const listener of process.rawListeners("SIGTERM")) {
      if (!initialSigtermListeners.has(listener)) {
        Reflect.apply(listener, process, ["SIGTERM"]);
      }
    }
    process.argv = originalArgv;
    if (originalExitDescriptor !== undefined) {
      Object.defineProperty(process, "exit", originalExitDescriptor);
    }
    vi.restoreAllMocks();
  });

  it("disposes the local HTTP MCP handler before closing the runtime", async () => {
    const shutdownOrder: string[] = [];
    const runtime = {
      close: vi.fn(() => {
        shutdownOrder.push("runtime");
        return Promise.resolve();
      }),
      createServer: vi.fn(),
      initialize: vi.fn(async () => {}),
      orchestrator: {},
      reindex: vi.fn(async () => {}),
      sanitizer: {},
    };
    const mcpHandler = Object.assign(vi.fn(async () => {}), {
      dispose: vi.fn(() => {
        shutdownOrder.push("handler");
        return Promise.resolve();
      }),
    });
    const httpServer = {
      close: vi.fn((callback: () => void) => {
        shutdownOrder.push("http");
        callback();
      }),
      listen: vi.fn((_port: number, _host: string, callback: () => void) => callback()),
    };
    mocks.createRuntime.mockResolvedValue(runtime);
    mocks.createStreamableHttpHandler.mockReturnValue(mcpHandler);
    mocks.createHttpServer.mockReturnValue(httpServer);

    const shutdown = await importCliAndGetShutdownHandler(["--port", "3001"]);
    Reflect.apply(shutdown, process, ["SIGTERM"]);

    await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledOnce());
    expect(mcpHandler.dispose).toHaveBeenCalledOnce();
    expect(shutdownOrder).toEqual(["http", "handler", "runtime"]);
  });

  it("reports existing indexing progress when the project is already locked", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.acquireProcessLock.mockResolvedValue({ acquired: false, existingPid: 12345 });
    mocks.readIndexProgress.mockResolvedValue({
      active: true,
      processedFiles: 12,
      totalFiles: 100,
    });
    process.argv = [originalArgv[0] ?? "node", originalArgv[1] ?? "nexus", "--reindex", "--full"];

    await import("../../../src/bin/nexus.js");

    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
    expect(error.mock.calls.flat().join("\n")).toContain("Progress: 12 / 100 files (running)");
  });

  it("delegates managed shutdown only to the managed server", async () => {
    const runtime = {
      close: vi.fn(async () => {}),
      createServer: vi.fn(),
      initialize: vi.fn(async () => {}),
      orchestrator: {},
      reindex: vi.fn(async () => {}),
      sanitizer: {},
    };
    const managedServer = {
      close: vi.fn(async () => {}),
      closed: Promise.resolve(),
      instanceId: "managed-test",
      url: new URL("http://127.0.0.1:43123"),
    };
    mocks.createRuntime.mockResolvedValue(runtime);
    mocks.startManagedHttpServer.mockResolvedValue(managedServer);

    const shutdown = await importCliAndGetShutdownHandler(["--port", "0", "--managed"]);
    Reflect.apply(shutdown, process, ["SIGTERM"]);

    await vi.waitFor(() => expect(managedServer.close).toHaveBeenCalledOnce());
    expect(mocks.createStreamableHttpHandler).not.toHaveBeenCalled();
    expect(runtime.close).not.toHaveBeenCalled();
  });

  it("shows only default server options in top-level help", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.argv = [originalArgv[0] ?? "node", originalArgv[1] ?? "nexus", "--help"];

    await import("../../../src/bin/nexus.js");

    const output = log.mock.calls.flat().join("\n");
    expect(output).not.toContain("--url");
    expect(output).toContain("Server options (no subcommand):");
  });

  it("lists every registered command in top-level help", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.argv = [originalArgv[0] ?? "node", originalArgv[1] ?? "nexus", "--help"];

    await import("../../../src/bin/nexus.js");

    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("Commands:");
    expect(output).toContain("dashboard");
    expect(output).toContain("aggregator");
    expect(output).toContain("http-bridge");
  });

  it("does not mutate process.argv when dispatching a subcommand", async () => {
    vi.doMock(new URL("../../../src/dashboard/cli.js", import.meta.url).href, () => ({
      main: mocks.dashboardMain,
    }));
    const argv = [
      originalArgv[0] ?? "node",
      originalArgv[1] ?? "nexus",
      "dashboard",
      "--port",
      "9470",
    ];
    process.argv = argv;

    await import("../../../src/bin/nexus.js");

    await vi.waitFor(() => expect(mocks.dashboardMain).toHaveBeenCalledWith(["--port", "9470"]));
    expect(process.argv).toBe(argv);
    expect(process.argv).toEqual(argv);
  });

  it("reports the dispatched command name when startup fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.dashboardMain.mockRejectedValueOnce(new Error("dashboard startup failed"));
    vi.doMock(new URL("../../../src/dashboard/cli.js", import.meta.url).href, () => ({
      main: mocks.dashboardMain,
    }));
    process.argv = [originalArgv[0] ?? "node", originalArgv[1] ?? "nexus", "dashboard"];

    await import("../../../src/bin/nexus.js");

    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
    expect(error.mock.calls.flat().join("\n")).toContain("Failed to start dashboard");
  });

  it("rejects an unknown subcommand and lists valid command names", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.argv = [originalArgv[0] ?? "node", originalArgv[1] ?? "nexus", "bogus-command"];

    await import("../../../src/bin/nexus.js");

    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
    const output = error.mock.calls.flat().join("\n");
    expect(output).toContain("Unknown command: bogus-command");
    expect(output).toContain("dashboard");
    expect(output).toContain("aggregator");
    expect(output).toContain("http-bridge");
    expect(mocks.createRuntime).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Nexus #297 Task 4: writer admission precedes every CLI storage/PID mutation.
  // ---------------------------------------------------------------------------------------------------------------
  const ownershipRefusal = () => Object.assign(new Error("storage ownership owner_conflict: owned by another project"),
    { name: "StorageOwnershipError", code: "owner_conflict" });

  async function runCli(args: readonly string[]): Promise<void> {
    process.argv = [originalArgv[0] ?? "node", originalArgv[1] ?? "nexus", ...args];
    await import("../../../src/bin/nexus.js");
  }

  it("CLI_foreign_owner_refuses_before_nexus_pid", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.admitStorageWriter.mockRejectedValue(ownershipRefusal());
    await runCli([]);
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
    expect(error.mock.calls.flat().join("\n")).toContain("owner_conflict");
    expect(mocks.acquireProcessLock).not.toHaveBeenCalled();
    expect(mocks.createRuntime).not.toHaveBeenCalled();
  });

  it("reindex_does_not_open_foreign_metadata", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.admitStorageWriter.mockRejectedValue(ownershipRefusal());
    await runCli(["--reindex", "--full"]);
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
    expect(mocks.createRuntime).not.toHaveBeenCalled();
    expect(mocks.acquireProcessLock).not.toHaveBeenCalled();
    expect(mocks.readIndexProgress).not.toHaveBeenCalled();
  });

  it("foreign_pid_not_unlinked_on_failed_admission", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitListeners = new Set(process.rawListeners("exit"));
    mocks.admitStorageWriter.mockRejectedValue(ownershipRefusal());
    await runCli(["--port", "0", "--managed"]);
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
    expect(process.rawListeners("exit").filter((l) => !exitListeners.has(l))).toEqual([]);
    expect(mocks.releaseProcessLock).not.toHaveBeenCalled();
    expect(mocks.releaseOwnedProcessLock).not.toHaveBeenCalled();
    expect(mocks.releaseOwnedProcessLockSync).not.toHaveBeenCalled();
  });

  it("releases only its own unconsumed admission when the PID lock is held by a live process", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.acquireProcessLock.mockResolvedValue({ acquired: false, existingPid: 4242 });
    await runCli([]);
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
    expect(admission.release).toHaveBeenCalledOnce();
    expect(mocks.releaseOwnedProcessLock).not.toHaveBeenCalled();
    expect(mocks.createRuntime).not.toHaveBeenCalled();
  });

  it("transfers the admission to the guarded factory and never releases it after transfer", async () => {
    const order: string[] = [];
    mocks.admitStorageWriter.mockImplementation(async () => { order.push("admit"); return admission; });
    mocks.acquireProcessLock.mockImplementation(async () => { order.push("pid"); return { acquired: true }; });
    const runtime = { close: vi.fn(async () => {}), createServer: vi.fn(), initialize: vi.fn(async () => {}),
      orchestrator: {}, reindex: vi.fn(async () => {}), sanitizer: {} };
    mocks.createRuntime.mockImplementation(async () => { order.push("runtime"); return runtime; });
    mocks.createStreamableHttpHandler.mockReturnValue(Object.assign(vi.fn(async () => {}), { dispose: vi.fn(async () => {}) }));
    mocks.createHttpServer.mockReturnValue({ close: vi.fn((cb: () => void) => cb()),
      listen: vi.fn((_p: number, _h: string, cb: () => void) => cb()) });
    const shutdown = await importCliAndGetShutdownHandler(["--port", "3001"]);
    expect(order).toEqual(["admit", "pid", "runtime"]);
    expect(mocks.acquireProcessLock).toHaveBeenCalledWith("/storage", { handle: admission, config });
    expect(mocks.createRuntime).toHaveBeenCalledWith(config, admission);
    Reflect.apply(shutdown, process, ["SIGTERM"]);
    await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledOnce());
    expect(admission.release).not.toHaveBeenCalled();
  });

  it("releases the unconsumed admission after owned PID cleanup when runtime construction fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const order: string[] = [];
    admission.release.mockImplementation(async () => { order.push("lease"); });
    mocks.releaseOwnedProcessLock.mockImplementation(async () => { order.push("pid"); });
    mocks.createRuntime.mockRejectedValue(new Error("construction failed"));
    await runCli([]);
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
    expect(order).toEqual(["pid", "lease"]);
  });

  it("release_after_stores_and_owned_pid_cleanup", async () => {
    const order: string[] = [];
    const runtime = { close: vi.fn(async () => { order.push("runtime"); }), createServer: vi.fn(),
      initialize: vi.fn(async () => {}), orchestrator: {}, reindex: vi.fn(async () => {}), sanitizer: {} };
    mocks.releaseOwnedProcessLock.mockImplementation(async () => { order.push("pid"); });
    mocks.createRuntime.mockResolvedValue(runtime);
    mocks.createStreamableHttpHandler.mockReturnValue(Object.assign(vi.fn(async () => {}),
      { dispose: vi.fn(async () => { order.push("handler"); }) }));
    mocks.createHttpServer.mockReturnValue({ close: vi.fn((cb: () => void) => { order.push("http"); cb(); }),
      listen: vi.fn((_p: number, _h: string, cb: () => void) => cb()) });
    const shutdown = await importCliAndGetShutdownHandler(["--port", "3001"]);
    Reflect.apply(shutdown, process, ["SIGTERM"]);
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));
    // Stop accepting work, remove the owned PID under the live lease, then close stores (runtime releases lease last).
    expect(order).toEqual(["http", "handler", "pid", "runtime"]);
    expect(mocks.releaseProcessLock).not.toHaveBeenCalled();
  });

  it("reindex removes the owned PID before closing the runtime", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const order: string[] = [];
    const runtime = { close: vi.fn(async () => { order.push("runtime"); }), reindex: vi.fn(async () => { order.push("reindex"); }) };
    mocks.releaseOwnedProcessLock.mockImplementation(async () => { order.push("pid"); });
    mocks.createRuntime.mockResolvedValue(runtime);
    await runCli(["--reindex"]);
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));
    expect(order).toEqual(["reindex", "pid", "runtime"]);
    expect(mocks.createRuntime).toHaveBeenCalledOnce();
    expect(mocks.createRuntime).toHaveBeenCalledWith(config, admission);
  });

  it("registers a fail-fast non-zero exit for a lost writer lease before transferring the admission", async () => {
    const leaseLoss = await import("../../../src/server/runtime/writer-lease-loss.js");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let registeredBeforeRuntime = false;
    const runtime = { close: vi.fn(async () => {}), createServer: vi.fn(() => ({ connect: vi.fn(async () => {}) })),
      initialize: vi.fn(async () => {}), orchestrator: {}, reindex: vi.fn(async () => {}), sanitizer: {} };
    mocks.createRuntime.mockImplementation(async () => {
      registeredBeforeRuntime = leaseLoss.getWriterLeaseLostHandler() !== undefined;
      return runtime;
    });
    mocks.createStreamableHttpHandler.mockReturnValue(Object.assign(vi.fn(async () => {}), { dispose: vi.fn(async () => {}) }));
    mocks.createHttpServer.mockReturnValue({ close: vi.fn((cb: () => void) => cb()),
      listen: vi.fn((_p: number, _h: string, cb: () => void) => cb()) });
    await importCliAndGetShutdownHandler(["--port", "3001"]);
    expect(registeredBeforeRuntime).toBe(true);
    leaseLoss.getWriterLeaseLostHandler()?.(new Error("lease gone"));
    expect(process.exit).toHaveBeenCalledWith(75);
    expect(error.mock.calls.flat().join("\n")).toContain("lease lost");
    expect(runtime.close).not.toHaveBeenCalled();
    leaseLoss.setWriterLeaseLostHandler(undefined);
  });
});
