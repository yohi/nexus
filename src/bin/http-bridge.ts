import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import type { Readable, Writable } from "node:stream";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import { ensureProjectEndpoint, type ProjectConnectorOptions } from "../server/project-connector.js";

export const DEFAULT_BRIDGE_URL = "http://127.0.0.1:3001";

class InvalidBridgeUrlError extends Error {
  override readonly name = "InvalidBridgeUrlError";

  constructor(cause: TypeError) {
    super("Invalid bridge URL", { cause });
  }
}

export interface HttpBridgeOptions {
  readonly url: URL;
  readonly input: Readable;
  readonly output: Writable;
  readonly errorOutput: Writable;
  readonly createTransport: (url: URL) => Transport;
}

export function resolveBridgeUrl(
  cliUrl: string | undefined,
  envUrl: string | undefined,
): URL {
  try {
    return new URL(cliUrl ?? envUrl ?? DEFAULT_BRIDGE_URL);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new InvalidBridgeUrlError(error);
    }

    throw error;
  }
}
export function resolveNexusExecutable(httpBridgeUrl: string | URL): string {
  const httpBridgePath = fileURLToPath(httpBridgeUrl);
  const httpBridgeDir = path.dirname(httpBridgePath);
  const httpBridgeName = path.basename(httpBridgePath);

  // When running from source (e.g. tsx src/bin/http-bridge.ts), prefer the
  // TypeScript entry. When running from the compiled distribution, prefer the
  // compiled JavaScript entry. Fall back to argv[1] only when neither exists.
  if (httpBridgeName.endsWith(".ts")) {
    const tsCandidate = path.join(httpBridgeDir, "nexus.ts");
    if (existsSync(tsCandidate)) {
      return tsCandidate;
    }
  }

  const jsCandidate = path.join(httpBridgeDir, "nexus.js");
  if (existsSync(jsCandidate)) {
    return jsCandidate;
  }

  return process.argv[1] ?? "nexus";
}

function writeDiagnostic(errorOutput: Writable, message: string): void {
  errorOutput.write(`${message}\n`);
}

function absorbEpipe(stream: Writable): void {
  stream.on("error", function handleStreamError(error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "EPIPE") {
      return;
    }

    stream.removeListener("error", handleStreamError);
    stream.emit("error", error);
  });
}

function parseJsonRpcLine(line: string, errorOutput: Writable): JSONRPCMessage | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch (error) {
    if (error instanceof SyntaxError) {
      writeDiagnostic(errorOutput, "Invalid JSON input");
      return undefined;
    }

    throw error;
  }

  const result = JSONRPCMessageSchema.safeParse(parsed);
  if (!result.success) {
    writeDiagnostic(errorOutput, "Invalid JSON-RPC input");
    return undefined;
  }

  return result.data;
}

export async function runHttpBridge(
  options: HttpBridgeOptions,
): Promise<void> {
  await runHttpBridgeWithSignalSource({
    ...options,
    signalSource: process,
  });
}

interface RunHttpBridgeWithSignalSourceOptions extends HttpBridgeOptions {
  readonly signalSource: NodeJS.EventEmitter;
}

export async function runHttpBridgeWithSignalSource(
  options: RunHttpBridgeWithSignalSourceOptions,
): Promise<void> {
  const transport = options.createTransport(options.url);
  const lines = createInterface({ input: options.input, crlfDelay: Infinity });
  let initializeRequestId: string | number | undefined;
  let transportClosed = false;
  let shutdownPromise: Promise<void> | undefined;
  absorbEpipe(options.output);
  absorbEpipe(options.errorOutput);

  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      lines.close();
      options.signalSource.removeListener("SIGINT", handleSignal);
      options.signalSource.removeListener("SIGTERM", handleSignal);

      if (!transportClosed) {
        if (
          typeof transport === "object" &&
          transport !== null &&
          "terminateSession" in transport &&
          typeof (transport as { terminateSession?: () => Promise<void> }).terminateSession === "function"
        ) {
          await (transport as { terminateSession: () => Promise<void> }).terminateSession().catch(() => undefined);
        }
        await transport.close();
      }
    })();

    return shutdownPromise;
  };

  const handleSignal = (): void => {
    void shutdown().catch(() => undefined);
  };

  transport.onmessage = (message) => {
    if ("result" in message && message.id === initializeRequestId) {
      const protocolVersion = message.result.protocolVersion;
      if (typeof protocolVersion === "string") {
        transport.setProtocolVersion?.(protocolVersion);
      }
    }

    options.output.write(`${JSON.stringify(message)}\n`);
  };
  transport.onerror = (error) => {
    writeDiagnostic(options.errorOutput, `HTTP bridge transport error: ${error.message}`);
  };
  transport.onclose = () => {
    transportClosed = true;
    lines.close();
  };

  options.signalSource.once("SIGINT", handleSignal);
  options.signalSource.once("SIGTERM", handleSignal);

  try {
    await transport.start();

    if (shutdownPromise === undefined) {
      for await (const line of lines) {
        if (line.trim() === "") {
          continue;
        }

        const message = parseJsonRpcLine(line, options.errorOutput);
        if (message === undefined) {
          continue;
        }

        if ("method" in message && "id" in message && message.method === "initialize") {
          initializeRequestId = message.id;
        }

        await transport.send(message);
      }
    }
  } finally {
    await shutdown();
  }
}

export interface BridgeCliResult {
  readonly help: boolean;
  readonly url: string | undefined;
  readonly projectRoot: string;
}

export function parseBridgeArgs(
  argv: string[],
  env: NodeJS.ProcessEnv,
): BridgeCliResult {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: "string" },
      "project-root": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });

  const rawProjectRoot = ((values["project-root"] as string) ?? env.NEXUS_PROJECT_ROOT ?? "").trim();
  const projectRoot = rawProjectRoot ? path.resolve(rawProjectRoot) : process.cwd();

  return {
    help: values.help === true,
    url: values.url ?? env.NEXUS_BRIDGE_URL,
    projectRoot,
  };
}

export interface BridgeCliDependencies {
  readonly ensureProjectEndpoint: (options: { readonly projectRoot: string; readonly env: NodeJS.ProcessEnv }) => Promise<URL>;
  readonly runHttpBridge: typeof runHttpBridge;
  readonly bridgeStreams: {
    readonly input: Readable;
    readonly output: Writable;
    readonly errorOutput: Writable;
  };
}

export async function runBridgeCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  dependencies: BridgeCliDependencies,
): Promise<void> {
  const parsed = parseBridgeArgs(argv, env);

  if (parsed.help) {
    dependencies.bridgeStreams.errorOutput.write(
      `Nexus HTTP Bridge - stdio to Streamable HTTP MCP bridge\n\n` +
        `Usage:\n` +
        `  nexus http-bridge [options]\n\n` +
        `Options:\n` +
        `  --url <url>          Use an explicit Nexus Streamable HTTP endpoint\n` +
        `                       Auto-discovers or starts the project-local managed endpoint when omitted\n` +
        `  --project-root <path>  Project root directory for auto-managed server discovery\n` +
        `  -h, --help           Show help\n\n` +
        `Environment:\n` +
        `  NEXUS_BRIDGE_URL    Fallback URL if --url is not provided\n` +
        `  NEXUS_PROJECT_ROOT    Fallback project root if --project-root is not provided\n` +
        `\n`
    );
    return;
  }

  const url =
    parsed.url === undefined
      ? await dependencies.ensureProjectEndpoint({ projectRoot: parsed.projectRoot, env })
      : resolveBridgeUrl(parsed.url, undefined);

  await dependencies.runHttpBridge({
    ...dependencies.bridgeStreams,
    url,
    createTransport: (transportUrl) => new StreamableHTTPClientTransport(transportUrl),
  });
}
export async function main(): Promise<void> {
  await runBridgeCli(process.argv.slice(2), process.env, {
    ensureProjectEndpoint: async ({ projectRoot, env }) => {
      const { loadConfig } = await import("../config/index.js");
      const resolvedConfig = await loadConfig({ projectRoot, env });
      const options: ProjectConnectorOptions = {
        projectRoot,
        storageDir: resolvedConfig.storage.rootDir,
        childExecutable: resolveNexusExecutable(import.meta.url),
        env,
        spawn,
        fetch: globalThis.fetch,
      };
      return ensureProjectEndpoint(options);
    },
    runHttpBridge,
    bridgeStreams: {
      input: process.stdin,
      output: process.stdout,
      errorOutput: process.stderr,
    },
  });
}
