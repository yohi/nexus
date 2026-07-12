import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import type { Readable, Writable } from "node:stream";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

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

export async function runHttpBridge(options: HttpBridgeOptions): Promise<void> {
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
      process.removeListener("SIGINT", handleSignal);
      process.removeListener("SIGTERM", handleSignal);

      if (!transportClosed) {
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

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

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
}

export function parseBridgeArgs(
  argv: string[],
  env: NodeJS.ProcessEnv,
): BridgeCliResult {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });

  return {
    help: values.help === true,
    url: values.url ?? env.NEXUS_BRIDGE_URL,
  };
}

export async function main(): Promise<void> {
  const { help, url } = parseBridgeArgs(process.argv.slice(2), process.env);

  if (help) {
    console.error(
      `Nexus HTTP Bridge - stdio to Streamable HTTP MCP bridge\n\n` +
        `Usage:\n` +
        `  nexus http-bridge [options]\n\n` +
        `Options:\n` +
        `  --url <url>  Nexus Streamable HTTP endpoint (default: ${DEFAULT_BRIDGE_URL})\n` +
        `  -h, --help   Show help\n\n` +
        `Environment:\n` +
        `  NEXUS_BRIDGE_URL  Fallback URL if --url is not provided`,
    );
    return;
  }

  await runHttpBridge({
    url: resolveBridgeUrl(url, undefined),
    input: process.stdin,
    output: process.stdout,
    errorOutput: process.stderr,
    createTransport: (transportUrl) => new StreamableHTTPClientTransport(transportUrl),
  });
}
