import { randomUUID } from "node:crypto";
import { open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export interface ProjectEndpoint {
  readonly instanceId: string;
  readonly pid: number;
  readonly projectRoot: string;
  readonly url: string;
}

export const PROJECT_ENDPOINT_FILENAME = "endpoint.json";

const projectEndpointSchema = z
  .object({
    instanceId: z.string(),
    pid: z.number(),
    projectRoot: z.string(),
    url: z.string(),
  })
  .strict();

const isMissingFileError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT";

export async function writeProjectEndpoint(
  storageDir: string,
  endpoint: ProjectEndpoint,
): Promise<void> {
  const target = join(storageDir, PROJECT_ENDPOINT_FILENAME);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(endpoint)}\n`, { mode: 0o600 });
  try {
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function readProjectEndpoint(storageDir: string): Promise<ProjectEndpoint | undefined> {
  const target = join(storageDir, PROJECT_ENDPOINT_FILENAME);
  let content: string;

  try {
    content = await readFile(target, "utf8");
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }

  let rawEndpoint: unknown;
  try {
    rawEndpoint = JSON.parse(content);
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }

  const result = projectEndpointSchema.safeParse(rawEndpoint);
  return result.success ? result.data : undefined;
}

export async function removeProjectEndpoint(storageDir: string): Promise<void> {
  const target = join(storageDir, PROJECT_ENDPOINT_FILENAME);

  try {
    await unlink(target);
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

export async function removeProjectEndpointIfMatching(
  storageDir: string,
  expected: ProjectEndpoint,
): Promise<void> {
  const target = join(storageDir, PROJECT_ENDPOINT_FILENAME);

  let observedInode: number;
  let observedDevice: number;
  try {
    const handle = await open(target, "r");
    try {
      const content = await handle.readFile("utf8");
      let rawEndpoint: unknown;
      try {
        rawEndpoint = JSON.parse(content);
      } catch {
        return;
      }
      const result = projectEndpointSchema.safeParse(rawEndpoint);
      if (
        !result.success ||
        result.data.instanceId !== expected.instanceId ||
        result.data.pid !== expected.pid ||
        result.data.projectRoot !== expected.projectRoot ||
        result.data.url !== expected.url
      ) {
        return;
      }

      // Record which file we validated so we can detect (below) whether
      // another process replaced it with a fresh descriptor before unlink().
      const stats = await handle.stat();
      observedInode = stats.ino;
      observedDevice = stats.dev;
    } finally {
      await handle.close();
    }
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return;
    }
    throw error;
  }

  try {
    // Re-validate the directory entry immediately before deleting. If a
    // different process published a new descriptor (via writeProjectEndpoint's
    // rename) after we read and validated the content above, the target path
    // now resolves to a different inode and must not be removed, even though
    // its content happened to satisfy the checks above at read time.
    const currentStats = await stat(target);
    if (currentStats.ino !== observedInode || currentStats.dev !== observedDevice) {
      return;
    }
    await unlink(target);
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

export async function waitForProjectEndpoint(
  storageDir: string,
  options: { readonly timeoutMs: number },
): Promise<ProjectEndpoint | undefined> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
    throw new RangeError("timeoutMs must be a finite, non-negative number.");
  }

  const deadline = Date.now() + options.timeoutMs;

  while (true) {
    const endpoint = await readProjectEndpoint(storageDir);
    if (endpoint !== undefined) {
      return endpoint;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return undefined;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(25, remainingMs));
    });
  }
}
