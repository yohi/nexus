#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import React from "react";
import { render } from "ink";
import { App } from "./app.js";

const { values } = parseArgs({
  options: {
    port: { type: "string" },
    interval: { type: "string", default: "2000" },
    "project-root": { type: "string" },
  },
  strict: true,
});

const projectRoot = (() => {
  const raw = values["project-root"];
  return raw ? path.resolve(raw) : process.cwd();
})();

/** Resolve the .nexus storage dir: env var > .nexus.json > default */
export async function resolveStorageDir(projectRoot: string): Promise<string> {
  if (process.env.NEXUS_STORAGE_ROOT_DIR) {
    return path.resolve(process.env.NEXUS_STORAGE_ROOT_DIR);
  }
  try {
    const raw = await readFile(path.join(projectRoot, ".nexus.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const rootDir = (parsed as Record<string, unknown>).storage;
      if (rootDir !== null && typeof rootDir === "object" && !Array.isArray(rootDir)) {
        const val = (rootDir as Record<string, unknown>).rootDir;
        if (typeof val === "string" && val.trim() !== "") {
          return path.resolve(projectRoot, val.trim());
        }
      }
    }
  } catch {
    // .nexus.json がなければデフォルトを使う
  }
  return path.join(projectRoot, ".nexus");
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

const storageDir = await resolveStorageDir(projectRoot);
const autoPort = await readMetricsPortFile(storageDir);

const port = (() => {
  if (values.port !== undefined) {
    const parsed = parseInt(values.port, 10);
    if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
      console.warn(`Invalid --port value "${values.port}", falling back to 9464`);
      return 9464;
    }
    return parsed;
  }
  if (autoPort !== undefined) {
    return autoPort;
  }
  // サーバーがまだ起動していない場合のフォールバック
  console.warn("[Nexus Dashboard] metrics.port not found, using default 9464. Is the server running?");
  return 9464;
})();

const interval = (() => {
  const parsed = parseInt(values.interval as string, 10);
  if (isNaN(parsed) || parsed < 1000) {
    console.warn(`Invalid --interval value "${values.interval}", falling back to 2000 (min 1000ms)`);
    return 2000;
  }
  return parsed;
})();

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { waitUntilExit } = render(React.createElement(App, { port, interval }));
  await waitUntilExit();
}
