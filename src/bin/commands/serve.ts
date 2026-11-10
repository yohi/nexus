import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { parseArgs } from 'node:util';

import { isLoopbackHost, loadConfig } from '../../config/index.js';
import { startHttpV2Server } from '../../server/http-v2/entry.js';
import { createV2McpHandler } from '../../server/http-v2/server-factory.js';
import { createV1RuntimeToolBridge, type V1RuntimeToolBridge } from '../../server/http-v2/v1-runtime-bridge.js';
import { NexusServerFactory } from '../../server/factory.js';
import { setWriterLeaseLostHandler } from '../../server/runtime/writer-lease-loss.js';
import type { NexusRuntime } from '../../server/index.js';
import type { Config } from '../../types/index.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 9200;

export interface ServeCliArgs {
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly projectRoot: string | undefined;
  readonly help: boolean;
}

export interface ServeCliDependencies {
  readonly output: Writable;
  readonly errorOutput: Writable;
  readonly exit: (code: number) => void;
  readonly signalSource: EventEmitter;
  readonly loadConfig?: typeof loadConfig;
  readonly createRuntime?: (config: Config) => Promise<NexusRuntime>;
  readonly createToolBridge?: typeof createV1RuntimeToolBridge;
  readonly createMcpHandler?: typeof createV2McpHandler;
  readonly startServer?: typeof startHttpV2Server;
}

const parsePort = (value: string): number => {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid port: ${value}`);
  }
  const port = Number.parseInt(value, 10);
  if (port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
};

export const parseServeArgs = (args: string[]): ServeCliArgs => {
  const { values } = parseArgs({
    args,
    options: {
      host: { type: 'string' },
      port: { type: 'string' },
      'project-root': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });

  return {
    host: values.host,
    port: values.port === undefined ? undefined : parsePort(values.port),
    projectRoot: values['project-root'],
    help: values.help === true,
  };
};

export const resolveServeEndpoint = (
  cli: ServeCliArgs,
  config: Config,
): { readonly host: string; readonly port: number } => {
  const host = (cli.host ?? config.http?.host ?? DEFAULT_HOST).trim().replace(/^\[|\]$/g, '');
  const port = cli.port ?? config.http?.port ?? DEFAULT_PORT;
  if (!isLoopbackHost(host)) {
    throw new Error(`nexus serve can only bind to a loopback interface, but received "${host}".`);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${String(port)}`);
  }
  return { host, port };
};

const printHelp = (output: Writable): void => {
  output.write(`Usage: nexus serve [options]

Start a local MCP v2 HTTP server bound to a loopback interface.

Options:
  --host <address>       Bind address (default: 127.0.0.1)
  --port <number>        Listen port (default: 9200)
  --project-root <path>  Project root directory (default: current working directory)
  -h, --help             Show this help
`);
};

export const runServeCli = async (
  argv: string[],
  env: NodeJS.ProcessEnv,
  dependencies: ServeCliDependencies,
): Promise<void> => {
  let cli: ServeCliArgs;
  try {
    cli = parseServeArgs(argv);
  } catch (error) {
    dependencies.errorOutput.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    dependencies.exit(1);
    return;
  }

  if (cli.help) {
    printHelp(dependencies.output);
    return;
  }

  const projectRoot = path.resolve(cli.projectRoot ?? env.NEXUS_PROJECT_ROOT ?? process.cwd());
  const load = dependencies.loadConfig ?? loadConfig;
  const createRuntime = dependencies.createRuntime ?? ((config: Config) => NexusServerFactory.createRuntime(config));
  const createToolBridge = dependencies.createToolBridge ?? createV1RuntimeToolBridge;
  const createHandler = dependencies.createMcpHandler ?? createV2McpHandler;
  const startServer = dependencies.startServer ?? startHttpV2Server;
  let runtime: NexusRuntime | undefined;
  let toolBridge: V1RuntimeToolBridge | undefined;

  try {
    const config = await load({ projectRoot, env, transportMode: 'v2-http' });
    const endpoint = resolveServeEndpoint(cli, config);
    const http = config.http;
    if (http === undefined) {
      throw new Error('Local HTTP v2 requires HTTP configuration.');
    }

    // Nexus #297: a lost storage writer lease terminates fail-fast; never keep serving or writing without it.
    setWriterLeaseLostHandler((error) => {
      dependencies.errorOutput.write(`Error: storage writer lease lost: ${error.message}\n`);
      dependencies.exit(75);
    });
    const initializedRuntime = await createRuntime(config);
    runtime = initializedRuntime;
    let ready = false;
    await initializedRuntime.initialize();
    ready = true;
    toolBridge = await createToolBridge(initializedRuntime.createServer());
    const handler = createHandler({
      handlers: toolBridge.handlers,
      limits: { topK: http.maxTopK, maxResults: http.maxResultsLimit },
    });
    const server = await startServer({
      handler,
      isReady: () => ready,
      host: endpoint.host,
      port: endpoint.port,
    });

    dependencies.output.write(`nexus serve listening on ${endpoint.host}:${server.port()}\n`);

    let shutdownInProgress = false;
    const shutdown = (): void => {
      if (shutdownInProgress) {
        return;
      }
      shutdownInProgress = true;
      void (async () => {
        await server.close();
        await toolBridge?.close();
        await runtime?.close();
        dependencies.exit(0);
      })().catch((error: unknown) => {
        dependencies.errorOutput.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
        dependencies.exit(1);
      });
    };
    dependencies.signalSource.once('SIGINT', shutdown);
    dependencies.signalSource.once('SIGTERM', shutdown);
  } catch (error) {
    await toolBridge?.close();
    await runtime?.close();
    dependencies.errorOutput.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    dependencies.exit(1);
  }
};

export const main = async (args: string[] = process.argv.slice(2)): Promise<void> => {
  await runServeCli(args, process.env, {
    output: process.stdout,
    errorOutput: process.stderr,
    exit: process.exit.bind(process),
    signalSource: process,
  });
};
