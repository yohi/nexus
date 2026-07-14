import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquireProcessLock: vi.fn(),
  createHttpServer: vi.fn(),
  createRestApiHandler: vi.fn(),
  createRuntime: vi.fn(),
  createStreamableHttpHandler: vi.fn(),
  loadConfig: vi.fn(),
  releaseProcessLock: vi.fn(),
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
  LOCK_FILENAME: "nexus.pid",
}));

vi.mock("../../../src/server/managed-http-server.js", () => ({
  startManagedHttpServer: mocks.startManagedHttpServer,
}));

const originalArgv = [...process.argv];
const originalExitDescriptor = Object.getOwnPropertyDescriptor(process, "exit");
type RawProcessListener = ReturnType<typeof process.rawListeners>[number];
let initialSigintListeners: Set<RawProcessListener>;
let initialSigtermListeners: Set<RawProcessListener>;

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
    mocks.releaseProcessLock.mockResolvedValue(undefined);
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
});
