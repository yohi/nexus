import type { Writable } from "node:stream";
import path from "node:path";
import { parseArgs } from "node:util";

import { loadConfig } from "../config/index.js";
import { handleFatalError } from "./fatal-error.js";

const DEFAULT_AGGREGATOR_PORT = 9470;

export interface AggregatorCliResult {
  readonly help: boolean;
  readonly port: string | undefined;
  readonly projectRoot: string;
}

interface AggregatorServer {
  start(port: number): Promise<void>;
  stop(): Promise<void>;
}

export interface AggregatorCliDependencies {
  readonly createAggregator: () => Promise<AggregatorServer>;
  readonly errorOutput: Writable;
  readonly loadConfig: (options: {
    readonly projectRoot: string;
    readonly env: NodeJS.ProcessEnv;
  }) => Promise<{ readonly aggregatorPort?: number }>;
  readonly output: Writable;
  readonly signalSource: NodeJS.EventEmitter;
}

export function parseAggregatorArgs(
  argv: string[],
  env: NodeJS.ProcessEnv,
): AggregatorCliResult {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string" },
      "project-root": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  const rawProjectRoot = (values["project-root"] ?? env.NEXUS_PROJECT_ROOT ?? "").trim();

  return {
    help: values.help === true,
    port: values.port,
    projectRoot: rawProjectRoot ? path.resolve(rawProjectRoot) : process.cwd(),
  };
}

export function resolveAggregatorPort(
  cliPort: string | undefined,
  configPort: number | undefined,
  envPort: string | undefined,
): number {
  let port: number;

  if (cliPort !== undefined) {
    if (!/^\d+$/.test(cliPort)) {
      throw new Error(`Invalid port value: ${cliPort}`);
    }
    port = Number.parseInt(cliPort, 10);
  } else if (configPort !== undefined) {
    port = configPort;
  } else if (envPort) {
    const rawEnvPort = envPort.trim();
    if (!/^\d+$/.test(rawEnvPort)) {
      throw new Error(`Invalid NEXUS_AGGREGATOR_PORT environment variable: ${rawEnvPort}`);
    }
    port = Number.parseInt(rawEnvPort, 10);
  } else {
    port = DEFAULT_AGGREGATOR_PORT;
  }

  if (Number.isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }

  return port;
}

export async function runAggregatorCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  dependencies: AggregatorCliDependencies,
): Promise<void> {
  const parsed = parseAggregatorArgs(argv, env);

  if (parsed.help) {
    dependencies.output.write(
      `Nexus Metrics Aggregator - Standalone Prometheus metrics aggregator\n\n` +
        `Usage:\n` +
        `  nexus-aggregator [options]\n\n` +
        `Options:\n` +
        `  --port <number>        Port for the metrics aggregator server (default: 9470)\n` +
        `  --project-root <path>  Path to the project root directory\n` +
        `  -h, --help             Show help\n`,
    );
    return;
  }

  const config = await dependencies.loadConfig({ projectRoot: parsed.projectRoot, env });
  const aggregatorPort = resolveAggregatorPort(
    parsed.port,
    config.aggregatorPort,
    env.NEXUS_AGGREGATOR_PORT,
  );
  const aggregator = await dependencies.createAggregator();
  await aggregator.start(aggregatorPort);
  dependencies.errorOutput.write(
    `🚀 Nexus Metrics Aggregator running on http://127.0.0.1:${aggregatorPort}\n`,
  );

  const handleShutdown = (): void => {
    aggregator.stop()
      .then(() => {
        process.exit(0);
      })
      .catch((error: unknown) => {
        handleFatalError("Failed to stop aggregator", error);
      });
  };
  dependencies.signalSource.once("SIGINT", handleShutdown);
  dependencies.signalSource.once("SIGTERM", handleShutdown);
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  try {
    await runAggregatorCli(args, process.env, {
      createAggregator: async () => {
        interface DashboardCliModule {
          readonly AggregatorServer?: new () => AggregatorServer;
        }

        const module = (await import(new URL("../dashboard/cli.js", import.meta.url).href)) as DashboardCliModule;
        if (module.AggregatorServer === undefined) {
          throw new Error("Dashboard module did not export AggregatorServer");
        }
        return new module.AggregatorServer();
      },
      errorOutput: process.stderr,
      loadConfig,
      output: process.stdout,
      signalSource: process,
    });
  } catch (error) { // no-excuse-ok: catch -- CLI boundary reports unexpected startup failures.
    handleFatalError("Failed to start aggregator", error);
  }
}

