import { spawn } from "node:child_process";
import { readFile, mkdir, readdir, rename, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { finished } from "node:stream/promises";
import picomatch from "picomatch";

import { initializeNexusRuntime, type NexusRuntime } from "./index.js";
import { PathSanitizer } from "./path-sanitizer.js";
import { SemanticSearch } from "../search/semantic.js";
import { SearchOrchestrator } from "../search/orchestrator.js";
import { PluginRegistry } from "../plugins/registry.js";
import { IndexPipeline } from "../indexer/pipeline.js";
import { Chunker } from "../indexer/chunker.js";
import { TypeScriptLanguagePlugin } from "../plugins/languages/typescript.js";
import { PythonLanguagePlugin } from "../plugins/languages/python.js";
import { GoLanguagePlugin } from "../plugins/languages/go.js";
import { OllamaEmbeddingProvider } from "../plugins/embeddings/ollama.js";
import { OpenAICompatEmbeddingProvider } from "../plugins/embeddings/openai-compat.js";
import { SqliteMetadataStore } from "../storage/metadata-store.js";
import { LanceVectorStore } from "../storage/vector-store.js";
import { RipgrepEngine } from "../search/grep.js";
import { FileWatcher } from "../indexer/watcher.js";
import { EventQueue } from "../indexer/event-queue.js";
import type { Config, GrepMatch, IndexEvent } from "../types/index.js";

/**
 * Type-safe interface for ripgrep JSON output.
 */
interface RipgrepMatchData {
  type: "match" | "begin" | "end" | "summary";
  data: {
    path: { text: string };
    line_number: number;
    lines: { text: string };
    submatches: Array<{
      start: number;
      end: number;
      match: { text: string };
    }>;
  };
}

/**
 * Handles directory scanning and file discovery.
 */
class DirectoryScanner {
  private static scanCounter = 0;
  private static readonly LOG_THROTTLE_THRESHOLD = 100;

  static async scan(
    dir: string,
    projectRoot: string,
    ignorePaths: string[],
    onProgress?: (msg: string) => void,
    isInitial = true,
    isIgnored?: (path: string) => boolean,
  ): Promise<IndexEvent[]> {
    if (isInitial) {
      this.scanCounter = 0;
      const patterns = ignorePaths.flatMap((p) => {
        const normalized = p.replaceAll("\\", "/").replace(/^\.\/+|\/+$/g, "");
        return [`**/${normalized}`, `**/${normalized}/**`];
      });
      isIgnored = picomatch(patterns, { windows: true });
    }

    const entries = await readdir(resolve(dir), { withFileTypes: true });
    const events: IndexEvent[] = [];

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = relative(projectRoot, fullPath);
      const relPathForMatch = relPath.split(sep).join("/");

      if (isIgnored?.(relPathForMatch)) {
        continue;
      }

      this.scanCounter += 1;
      if (onProgress && this.scanCounter % this.LOG_THROTTLE_THRESHOLD === 0) {
        onProgress(
          `Scanning progress: ${this.scanCounter} entries reached (currently at ${relPath})`,
        );
      }

      if (entry.isDirectory()) {
        events.push(
          ...(await this.scan(
            fullPath,
            projectRoot,
            ignorePaths,
            onProgress,
            false,
            isIgnored,
          )),
        );
      } else if (entry.isFile()) {
        events.push({
          type: "added",
          filePath: relPath,
          detectedAt: new Date().toISOString(),
        });
      }
    }
    return events;
  }
}

/**
 * Manages storage initialization and directory creation.
 */
class StorageManager {
  static async ensureDirectories(config: Config): Promise<void> {
    const root = resolve(config.storage.rootDir);
    const meta = dirname(resolve(config.storage.metadataDbPath));
    const vector = resolve(config.storage.vectorDbPath);

    await mkdir(root, { recursive: true });
    await mkdir(meta, { recursive: true });
    if (!config.storage.vectorDbPath.startsWith("memory://")) {
      await mkdir(vector, { recursive: true });
    }
  }

  static initializeStores(config: Config) {
    const metadataStore = new SqliteMetadataStore({
      databasePath: config.storage.metadataDbPath,
      batchSize: config.storage.batchSize,
    });

    const vectorStore = new LanceVectorStore({
      dbPath: config.storage.vectorDbPath,
      dimensions: config.embedding.dimensions,
    });

    return { metadataStore, vectorStore };
  }
}

/**
 * Orchestrates background event processing and file watching.
 */
class EventProcessingManager {
  private abortController = new AbortController();
  private drainTask?: Promise<void>;
  private fullScanPromise?: Promise<void>;

  constructor(
    private config: Config,
    private projectRoot: string,
    private ignorePaths: string[],
    private pipeline: IndexPipeline,
    private loadFileContent: (path: string) => Promise<string>,
    private onLog?: (msg: string) => void,
  ) {}

  setup() {
    const eventQueue = new EventQueue({
      debounceMs: this.config.watcher.debounceMs,
      maxQueueSize: this.config.watcher.maxQueueSize,
      fullScanThreshold: this.config.watcher.fullScanThreshold,
      concurrency: 4,
      onFullScanRequired: () => {
        const p = this.triggerFullScan().finally(() => {
          if (this.fullScanPromise === p) {
            this.fullScanPromise = undefined;
          }
        });
        this.fullScanPromise = p;
        return Promise.resolve();
      },
    });

    const watcher = new FileWatcher(
      { projectRoot: this.projectRoot, ignorePaths: this.ignorePaths },
      eventQueue,
    );

    this.drainTask = this.startDrainLoop(eventQueue);

    return { watcher, onClose: () => this.stop() };
  }

  private async stop() {
    this.abortController.abort();
    await Promise.allSettled([
      this.drainTask ?? Promise.resolve(),
      this.fullScanPromise ?? Promise.resolve(),
    ]);
  }

  private async triggerFullScan(retryCount = 3, baseDelayMs = 1000) {
    for (let attempt = 0; attempt < retryCount; attempt += 1) {
      if (this.abortController.signal.aborted) {
        return;
      }

      try {
        const result = await this.pipeline.reindex(
          () =>
            DirectoryScanner.scan(
              this.projectRoot,
              this.projectRoot,
              this.ignorePaths,
              this.onLog,
            ),
          this.loadFileContent,
          true,
        );

        if ("status" in result) {
          throw new Error("already_running");
        }

        if (this.onLog) {
          this.onLog("[Nexus] Background full scan completed successfully.");
        }
        return;
      } catch (err) {
        const isAlreadyRunning = (err as Error).message === "already_running";
        const msg = `[Nexus] Background full scan ${isAlreadyRunning ? "skipped" : "failed"} (attempt ${attempt + 1}/${retryCount})`;

        console.error(msg, err);
        if (this.onLog) {
          this.onLog(`${msg}: ${err}`);
        }

        // Use a dynamic check to prevent static analysis from falsely claiming this is always truthy
        const shouldWait = attempt < retryCount - 1;
        if (shouldWait && !this.abortController.signal.aborted) {
          const delay = baseDelayMs * Math.pow(2, attempt);
          try {
            await sleep(delay, undefined, {
              signal: this.abortController.signal,
            });
          } catch {
            // AbortError is expected
          }
        }
      }
    }
  }

  private async startDrainLoop(eventQueue: EventQueue) {
    while (!this.abortController.signal.aborted) {
      try {
        await eventQueue.drain(async (event) => {
          if (event.type === "reindex") {
            await this.triggerFullScan();
          } else {
            await this.pipeline.processEvents([event], this.loadFileContent);
          }
        });
      } catch (error) {
        console.error("[Nexus] Error in event queue drain loop:", error);
        if (this.onLog) {
          this.onLog(`[Nexus] Error in event queue drain loop: ${error}`);
        }
      }

      try {
        await sleep(500, undefined, { signal: this.abortController.signal });
      } catch {
        // AbortError is expected when the loop should terminate
      }
    }
  }
}

export class NexusServerFactory {
  /**
   * Creates and initializes a NexusRuntime based on the provided configuration.
   */
  static async createRuntime(config: Config): Promise<NexusRuntime> {
    const { projectRoot } = config;
    await StorageManager.ensureDirectories(config);

    const { metadataStore, vectorStore } =
      StorageManager.initializeStores(config);
    const pluginRegistry = this.setupPluginRegistry(config);
    const embeddingProvider = pluginRegistry.getEmbeddingProvider();

    if (!embeddingProvider) {
      throw new Error("No embedding provider configured.");
    }

    const LOG_MAX_BYTES = 10 * 1024 * 1024;
    const LOG_MAX_FILES = 5;

    const logFilePath = join(config.storage.rootDir, "indexer.log");
    let logStream = createWriteStream(logFilePath, { flags: "w" });
    let isBackedUp = false;
    let drainListener: (() => void) | null = null;
    const logQueue: string[] = [];
    let isRotating = false;

    const rotateLog = async () => {
      if (isRotating) return;
      isRotating = true;

      if (drainListener) {
        logStream.off("drain", drainListener);
        drainListener = null;
      }

      await finished(logStream).catch(() => {});

      for (let i = LOG_MAX_FILES - 1; i >= 1; i--) {
        const oldPath = join(config.storage.rootDir, `indexer.log.${i}`);
        const newPath = join(config.storage.rootDir, `indexer.log.${i + 1}`);
        try {
          await rename(oldPath, newPath);
        } catch {}
      }
      await rename(logFilePath, join(config.storage.rootDir, "indexer.log.1"));
      logStream = createWriteStream(logFilePath, { flags: "w" });
      logStream.on("error", (err) => {
        console.error("[Nexus] Log stream error:", err);
      });
      isBackedUp = false;
      isRotating = false;
      flushLogQueue();
    };

    const flushLogQueue = () => {
      while (logQueue.length > 0 && !isBackedUp && !isRotating) {
        const line = logQueue.shift()!;
        if (!logStream.write(line)) {
          isBackedUp = true;
          drainListener = () => {
            isBackedUp = false;
            drainListener = null;
            flushLogQueue();
          };
          logStream.once("drain", drainListener);
        }
      }
    };

    const onLog = (msg: string) => {
      const timestamp = new Date().toISOString();
      const line = `[${timestamp}] ${msg}\n`;
      try {
        stat(logFilePath)
          .then((s) => {
            if (s.size >= LOG_MAX_BYTES) {
              rotateLog();
            }
          })
          .catch(() => {});

        if (isBackedUp) {
          logQueue.push(line);
          return;
        }

        if (!logStream.write(line)) {
          isBackedUp = true;
          drainListener = () => {
            isBackedUp = false;
            drainListener = null;
            flushLogQueue();
          };
          logStream.once("drain", drainListener);
        }
      } catch (e) {
        console.error(
          `[Indexer Log Error] Failed to write to ${logFilePath}:`,
          e,
        );
        console.error(`Original message: ${msg}`);
      }
    };

    const semanticSearch = new SemanticSearch({
      vectorStore,
      embeddingProvider,
    });
    const grepEngine = this.createGrepEngine(projectRoot);
    const orchestrator = new SearchOrchestrator({
      semanticSearch,
      grepEngine,
      projectRoot,
    });
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker: new Chunker(pluginRegistry),
      embeddingProvider,
      pluginRegistry,
      onProgress: (msg) => onLog(msg),
    });

    const loadFileContent = (path: string) =>
      readFile(resolve(projectRoot, path), "utf8");
    const ignorePaths = config.watcher.ignorePaths ?? [];
    const eventManager = new EventProcessingManager(
      config,
      projectRoot,
      ignorePaths,
      pipeline,
      loadFileContent,
      onLog,
    );
    const { watcher, onClose } = eventManager.setup();

    try {
      return await initializeNexusRuntime({
        projectRoot,
        sanitizer: await PathSanitizer.create(projectRoot),
        semanticSearch,
        grepEngine,
        orchestrator,
        vectorStore,
        metadataStore,
        pipeline,
        pluginRegistry,
        watcher,
        loadFileContent,
        onClose: async () => {
          await onClose();
          if (drainListener) {
            logStream.off("drain", drainListener);
          }
          logStream.end();
          await finished(logStream);
        },
        runReindex: async (args) => {
          let scannedEvents: IndexEvent[] = [];
          const result = await pipeline.reindex(
            async () => {
              scannedEvents = await DirectoryScanner.scan(
                projectRoot,
                projectRoot,
                ignorePaths,
                onLog,
              );
              return scannedEvents;
            },
            loadFileContent,
            args?.fullScan,
          );

          if ("status" in result) {
            throw new Error(`Reindex already running: ${result.status}`);
          }
          return scannedEvents;
        },
      });
    } catch (error) {
      await onClose();
      logStream.end();
      throw error;
    }
  }

  private static setupPluginRegistry(config: Config): PluginRegistry {
    const registry = new PluginRegistry();
    registry.registerLanguage(new TypeScriptLanguagePlugin());
    registry.registerLanguage(new PythonLanguagePlugin());
    registry.registerLanguage(new GoLanguagePlugin());

    let provider;
    switch (config.embedding.provider) {
      case "ollama":
        provider = new OllamaEmbeddingProvider(config.embedding);
        break;
      case "openai-compat":
        provider = new OpenAICompatEmbeddingProvider(config.embedding);
        break;
      case "test":
        throw new Error(
          "Test embedding provider is not supported in production.",
        );
      default:
        throw new Error(
          "Unsupported embedding provider: " +
            String(config.embedding.provider),
        );
    }

    registry.registerEmbeddingProvider(config.embedding.provider, provider);
    registry.setActiveEmbeddingProvider(config.embedding.provider);
    return registry;
  }

  private static createGrepEngine(projectRoot: string): RipgrepEngine {
    return new RipgrepEngine({
      projectRoot,
      spawn: async (params, signal) =>
        new Promise((res, rej) => {
          const args = [
            "--json",
            ...(params.caseSensitive ? [] : ["--ignore-case"]),
          ];
          if (params.glob?.length) {
            params.glob.forEach((g) => args.push("--glob", g));
          }
          args.push("--", params.query, params.cwd);

          const child = spawn("rg", args, { signal });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (d: Buffer | string) => {
            stdout += d.toString();
          });
          child.stderr.on("data", (d: Buffer | string) => {
            stderr += d.toString();
          });
          child.on("close", (code) => {
            if (code !== 0 && code !== 1) {
              rej(new Error(`ripgrep failed: ${stderr}`));
              return;
            }
            res(this.parseGrepOutput(stdout));
          });
          child.on("error", (e) => {
            if (e.name === "AbortError") {
              res([]);
            } else {
              rej(e);
            }
          });
        }),
    });
  }

  private static parseGrepOutput(stdout: string): GrepMatch[] {
    return stdout
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((line) => {
        try {
          const parsed = JSON.parse(line) as RipgrepMatchData;
          if (parsed.type !== "match") {
            return null;
          }
          return {
            filePath: parsed.data.path.text,
            lineNumber: parsed.data.line_number,
            lineText: parsed.data.lines.text,
            submatches: parsed.data.submatches.map((m) => ({
              start: m.start,
              end: m.end,
              match: m.match.text,
            })),
          };
        } catch {
          return null;
        }
      })
      .filter((m): m is GrepMatch => m !== null);
  }
}
