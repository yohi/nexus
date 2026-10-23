import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

const requestSchema = z.object({
  model: z.string(),
  input: z.array(z.string()),
  dimensions: z.literal(2),
});
const cli = join(process.cwd(), "dist/bin/nexus.js");

describe.skipIf(process.env.NEXUS_E2E !== "1")(
  "embedding cache compatibility through the CLI",
  () => {
    let directory: string;
    let project: string;
    let server: Server;
    let baseUrl: string;
    let requests: Map<string, number>;

    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), "nexus-cache-e2e-"));
      project = join(directory, "project");
      await mkdir(project);
      await writeFile(
        join(project, "fixture.ts"),
        "export const cacheIdentityFixture = 42;\n",
      );
      requests = new Map();
      server = createServer(async (request, response) => {
        if (request.method === "GET") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ data: [] }));
          return;
        }
        let body = "";
        for await (const chunk of request)
          body += Buffer.isBuffer(chunk)
            ? chunk.toString("utf8")
            : String(chunk);
        const input = requestSchema.parse(JSON.parse(body));
        requests.set(input.model, (requests.get(input.model) ?? 0) + 1);
        if (input.model === "rejected-model") {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "model is unavailable" }));
          return;
        }
        const vector = input.model === "model-a" ? [1, 0] : [0, 1];
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            data: input.input.map(() => ({ embedding: vector })),
          }),
        );
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new TypeError("TCP listener required");
      baseUrl = `http://127.0.0.1:${address.port}`;
    });

    afterEach(async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    });

    function reindex(
      model: string,
    ): Promise<{ readonly code: number | null; readonly diagnostics: string }> {
      return new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [cli, "--project-root", project, "--reindex", "--full"],
          {
            stdio: ["ignore", "pipe", "pipe"],
            signal: AbortSignal.timeout(30000),
            env: {
              ...process.env,
              NEXUS_PACKAGE_MODE: "0",
              NEXUS_STORAGE_ROOT_DIR: join(directory, "storage"),
              NEXUS_EMBEDDING_PROVIDER: "openai-compat",
              NEXUS_EMBEDDING_BASE_URL: baseUrl,
              NEXUS_EMBEDDING_MODEL: model,
              NEXUS_EMBEDDING_DIMENSIONS: "2",
              NEXUS_EMBEDDING_API_KEY: "",
              NEXUS_EMBEDDING_HEADERS: "{}",
              NEXUS_EMBEDDING_RETRY_COUNT: "0",
            },
          },
        );
        let diagnostics = "";
        child.stdout.resume();
        child.stderr.on("data", (chunk) => {
          diagnostics += String(chunk);
        });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, diagnostics }));
      });
    }

    it("requests new embeddings when a restarted CLI changes to a same-dimension model", async () => {
      const first = await reindex("model-a");
      expect(first.code, first.diagnostics).toBe(0);
      const result = await reindex("model-b");
      expect(result.code, result.diagnostics).toBe(0);
      expect(requests.get("model-b")).toBeGreaterThan(0);
    });

    it("keeps a persistent cache hit when restarting the CLI with the same model", async () => {
      const first = await reindex("model-a");
      expect(first.code, first.diagnostics).toBe(0);
      const original = requests.get("model-a");
      const result = await reindex("model-a");
      expect(result.code, result.diagnostics).toBe(0);
      expect(requests.get("model-a")).toBe(original);
    });

    it("reports an unavailable new model instead of hiding the error behind an old cached vector", async () => {
      const first = await reindex("model-a");
      expect(first.code, first.diagnostics).toBe(0);
      const result = await reindex("rejected-model");
      expect(result.code).not.toBe(0);
      expect(requests.get("rejected-model")).toBeGreaterThan(0);
    });
  },
);
