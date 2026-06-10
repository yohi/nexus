import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SearchOrchestrator } from "../search/orchestrator.js";
import type { PathSanitizer } from "./path-sanitizer.js";
import { sanitizeErrorMessage } from "../utils/error-utils.js";

export interface RestApiOptions {
  orchestrator: SearchOrchestrator;
  sanitizer: PathSanitizer;
  projectRoot: string;
}

const MAX_BODY_SIZE = 1 * 1024 * 1024; // 1 MB
const MAX_QUERY_LENGTH = 10000;

class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const readBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let totalSize = 0;

  for await (const chunk of req) {
    const buffer: Buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as string | Uint8Array);
    totalSize += buffer.length;

    if (totalSize > MAX_BODY_SIZE) {
      throw new HttpError(413, "Payload Too Large: Request body exceeds 1MB limit");
    }

    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return undefined;
  }

  const rawBody = Buffer.concat(chunks as Uint8Array[]).toString("utf8");
  try {
    return JSON.parse(rawBody) as unknown;
  } catch (error) {
    throw new HttpError(
      400,
      `Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export const createRestApiHandler = (options: RestApiOptions) => {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      // Only POST /api/search is supported
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            error: "Method Not Allowed",
            allowedMethods: ["POST"],
          }),
        );
        return;
      }

      const body = await readBody(req);

      if (typeof body !== "object" || body === null) {
        throw new HttpError(400, "Request body must be a JSON object");
      }

      const { query, files } = body as Record<string, unknown>;

      if (typeof query !== "string" || query.trim().length === 0) {
        throw new HttpError(400, "Missing or invalid 'query' field");
      }

      // Validate query length
      const trimmedQuery = query.trim();
      if (trimmedQuery.length > MAX_QUERY_LENGTH) {
        throw new HttpError(
          400,
          `Query exceeds maximum length of ${MAX_QUERY_LENGTH} characters`,
        );
      }

      // Validate file paths if provided
      let validatedFiles: string[] | undefined;
      const invalidPaths: { path: string; error: string }[] = [];
      if (Array.isArray(files)) {
        const filePromises = files
          .filter((f): f is string => typeof f === "string")
          .map(async (f) => {
            try {
              const absolutePath = await options.sanitizer.sanitize(f);
              // Convert absolute path to project-root relative path for the orchestrator/grep engine
              return path.relative(options.projectRoot, absolutePath);
            } catch (error) {
              invalidPaths.push({
                path: f,
                error: error instanceof Error ? error.message : String(error),
              });
              return undefined;
            }
          });

        const resolved = await Promise.all(filePromises);
        validatedFiles = resolved.filter((f): f is string => f !== undefined);

        if (invalidPaths.length > 0) {
          console.warn(
            `[Nexus REST API] Invalid paths ignored: ${invalidPaths
              .map((p) => `${p.path} (${p.error})`)
              .join(", ")}`,
          );
        }
      }

      const searchResponse = await options.orchestrator.search({
        query: trimmedQuery,
        topK: 20,
        filePatterns: validatedFiles && validatedFiles.length > 0
          ? validatedFiles
          : undefined,
      });

      // Transform SearchResponse to nexus-commit expected format
      const results = searchResponse.results.map((result) => ({
        file: result.chunk.filePath,
        content: result.chunk.content,
      }));

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ results }));
    } catch (error) {
      if (error instanceof HttpError) {
        res.statusCode = error.statusCode;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: error.message }));
        return;
      }

      const safeMessage = sanitizeErrorMessage(error);
      console.error("[Nexus REST API Error]", error);

      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: safeMessage }));
    }
  };
};
