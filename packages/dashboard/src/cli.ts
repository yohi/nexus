#!/usr/bin/env node
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import React from "react";
import { render } from "ink";
import { App } from "./app.js";
import { AggregatorServer } from "./server/aggregator.js";

export interface DashboardProjectConfig {
  storage?: {
    rootDir?: string;
  };
  aggregatorPort?: number;
}

async function validateProjectRoot(projectRoot: string): Promise<string> {
  if (projectRoot.includes("\0")) {
    throw new Error('Project root contains invalid characters');
  }

  const normalizedInput = path.normalize(projectRoot);
  const segments = normalizedInput.split(/[\\/]+/).filter(Boolean);
  if (segments.includes('..')) {
    throw new Error('Project root must not contain parent directory traversal');
  }

  try {
    const info = await stat(projectRoot);
    if (!info.isDirectory()) {
      throw new Error('Project root must be an existing directory');
    }
  } catch {
    throw new Error('Project root must be an existing directory');
  }
  return realpath(projectRoot);
}

async function resolveProjectPathWithinRoot(projectRoot: string, relativePath: string): Promise<string> {
  const normalizedRelativePath = relativePath.trim();
  const candidate = path.resolve(projectRoot, normalizedRelativePath);
  const projectRootRealPath = await realpath(projectRoot);
  const candidateParentRealPath = await realpath(path.dirname(candidate));
  const relativeToRoot = path.relative(projectRootRealPath, candidateParentRealPath);
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    throw new Error('storage.rootDir must stay within the project root');
  }
  return candidate;
}

export async function loadProjectConfig(projectRoot: string): Promise<DashboardProjectConfig | undefined> {
  try {
    const raw = await readFile(path.join(projectRoot, ".nexus.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isDashboardProjectConfig(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the .nexus storage dir: env var > .nexus.json > default */
export async function resolveStorageDir(projectRoot: string, config?: DashboardProjectConfig): Promise<string> {
  if (process.env.NEXUS_STORAGE_ROOT_DIR) {
    return path.resolve(process.env.NEXUS_STORAGE_ROOT_DIR);
  }
  const effectiveConfig = config ?? await loadProjectConfig(projectRoot);
  const rootDir = effectiveConfig?.storage?.rootDir;
  if (typeof rootDir === "string" && rootDir.trim() !== "") {
    return resolveProjectPathWithinRoot(projectRoot, rootDir);
  }
  return path.join(projectRoot, ".nexus");
}

export function readAggregatorPortFromConfig(config?: DashboardProjectConfig): number | undefined {
  const value = config?.aggregatorPort;
  return Number.isInteger(value) && typeof value === "number" && value > 0 && value <= 65535
    ? value
    : undefined;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDashboardProjectConfig(value: unknown): value is DashboardProjectConfig {
  return isJsonObject(value);
}

/** Read port from <storageDir>/metrics.port written by the running server */
async function readMetricsPortFile(storageDir: string): Promise<number | undefined> {
  try {
    const content = await readFile(path.join(storageDir, "metrics.port"), "utf8");
    const port = Number.parseInt(content.trim(), 10);
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      return port;
    }
  } catch {
    // ファイルが存在しない場合は undefined
  }
  return undefined;
}

export async function main() {
  const { values } = parseArgs({
    options: {
      port: { type: "string" },
      interval: { type: "string", default: "2000" },
      "project-root": { type: "string" },
      "aggregator-port": { type: "string" },
    },
    strict: true,
  });

  const parsePortOption = (raw: string, optionName: string): number => {
    if (!/^\d+$/.test(raw)) {
      console.error(`[Nexus Dashboard] Invalid ${optionName} value "${raw}". Please specify a valid port number (1-65535).`);
      process.exit(1);
    }
    const parsed = Number.parseInt(raw, 10);
    if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
      console.error(`[Nexus Dashboard] Invalid ${optionName} value "${raw}". Please specify a valid port number (1-65535).`);
      process.exit(1);
    }
    return parsed;
  };

  const projectRootInput = (() => {
    const raw = values["project-root"];
    return raw ? path.resolve(raw) : process.cwd();
  })();
  const projectRoot = await validateProjectRoot(projectRootInput).catch((error: unknown) => {
    console.error(`[Nexus Dashboard] ${(error as Error).message}: ${projectRootInput}`);
    process.exit(1);
  });

  const projectConfig = await loadProjectConfig(projectRoot);
  const storageDir = await resolveStorageDir(projectRoot, projectConfig);
  const autoPort = await readMetricsPortFile(storageDir);
  const configAggregatorPort = readAggregatorPortFromConfig(projectConfig);

  const port = (() => {
    if (values.port !== undefined) {
      return parsePortOption(values.port, '--port');
    }
    if (autoPort !== undefined) {
      return autoPort;
    }
    console.error(
      `[Nexus Dashboard] Could not determine metrics port for project: ${projectRoot}\n` +
      `  Storage dir: ${storageDir}\n` +
      `  No metrics.port file found. Is the Nexus server running for this project?\n` +
      `  Hint: Start the server first, or specify the port with --port <number>.`
    );
    process.exit(1);
  })();

  const interval = (() => {
    const rawInterval = values.interval as string;
    if (!/^\d+$/.test(rawInterval)) {
      console.warn(`Invalid --interval value "${rawInterval}", falling back to 2000 (min 1000ms)`);
      return 2000;
    }
    const parsed = Number.parseInt(rawInterval, 10);
    if (isNaN(parsed) || parsed < 1000) {
      console.warn(`Invalid --interval value "${rawInterval}", falling back to 2000 (min 1000ms)`);
      return 2000;
    }
    return parsed;
  })();
  const aggregatorPort = (() => {
    if (values["aggregator-port"] !== undefined) {
      return parsePortOption(values["aggregator-port"], '--aggregator-port');
    }
    if (configAggregatorPort !== undefined) {
      return configAggregatorPort;
    }
    if (process.env.NEXUS_AGGREGATOR_PORT) {
      return parsePortOption(process.env.NEXUS_AGGREGATOR_PORT, 'NEXUS_AGGREGATOR_PORT');
    }
    return 9470;
  })();

  const aggregator = new AggregatorServer();
  try {
    await aggregator.start(aggregatorPort);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.warn(`[Nexus Dashboard] Aggregator already running on port ${aggregatorPort}, skipping setup.`);
    } else {
      // Non-fatal: continue with TUI even if aggregator fails (degraded mode).
      // Dashboard local metrics (from --port) remain functional.
      console.error('[Nexus Dashboard] Failed to start aggregator:', err);
    }
  }

  try {
    const { waitUntilExit } = render(React.createElement(App, { port, interval }));
    await waitUntilExit();
  } finally {
    await aggregator.stop();
  }
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;
  try {
    const argPath = path.resolve(process.argv[1]);
    const modulePath = fileURLToPath(import.meta.url);
    return argPath === modulePath;
  } catch {
    return false;
  }
}

if (await isMainModule()) {
  try {
    await main();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
