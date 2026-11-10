// Startup diagnostics redirection for managed children (Nexus #297, Design §4.4 F-001).
import { appendFileSync, closeSync, constants as fsConstants, fstatSync, openSync, writeSync } from "node:fs";

export interface StreamRedirection {
  /** Restore normal stream behaviour and release any descriptor held by the redirection. Idempotent. */
  readonly detach: () => void;
}

type WriteCallback = (error: Error | null | undefined) => void;

function patchStream(source: NodeJS.WriteStream, sink: (chunk: string | Uint8Array, encoding: BufferEncoding) => void, onDetach: () => void): StreamRedirection {
  // Own-property snapshot (usually absent: the prototype method), restored verbatim on detach.
  const ownWrite = Object.getOwnPropertyDescriptor(source, "write");
  const boundOriginal = source.write.bind(source);
  const patched = (
    chunk: unknown,
    encodingOrCallback?: BufferEncoding | WriteCallback,
    callback?: WriteCallback,
  ): boolean => {
    const resolvedEncoding = typeof encodingOrCallback === "string" ? encodingOrCallback : "utf8";
    const resolvedCallback = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    // Write synchronously so diagnostics survive an immediate process.exit() call (e.g. after a fatal console.error).
    try {
      sink(chunk as string | Uint8Array, resolvedEncoding);
    } catch {
      // Best-effort diagnostics only; never let a logging failure crash startup.
    }
    return boundOriginal(chunk as string | Buffer, resolvedEncoding, resolvedCallback);
  };
  source.write = patched as typeof source.write;
  let detached = false;
  return {
    detach: () => {
      if (detached) return;
      detached = true;
      if (source.write === (patched as typeof source.write)) {
        if (ownWrite === undefined) Reflect.deleteProperty(source, "write");
        else Object.defineProperty(source, "write", ownWrite);
      }
      onDetach();
    },
  };
}

/**
 * Open a Bridge attempt log that the Bridge already created (0600, owned by this account). Never creates a file (no
 * O_CREAT) and refuses symlinks (O_NOFOLLOW), non-regular files, foreign ownership and group/other access.
 */
export function openBridgeStartupLog(path: string): number {
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
      throw new Error(`unsafe Bridge startup log ${path}`);
    }
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return fd;
}

/**
 * Tee writes into an already-open descriptor. Writes go to the open inode, so a log the Bridge removed is never
 * re-created; `detach()` restores the stream and closes the descriptor.
 */
export function redirectStreamToFd(source: NodeJS.WriteStream, fd: number): StreamRedirection {
  return patchStream(
    source,
    (chunk, encoding) => {
      writeSync(fd, typeof chunk === "string" ? Buffer.from(chunk, encoding) : chunk);
    },
    () => {
      try { closeSync(fd); } catch { /* already closed */ }
    },
  );
}

/** Tee writes into a caller-chosen path (used only after writer admission for non-Bridge log paths). */
export function redirectStreamToPath(source: NodeJS.WriteStream, logPath: string): StreamRedirection {
  return patchStream(
    source,
    (chunk, encoding) => {
      appendFileSync(logPath, chunk, typeof chunk === "string" ? encoding : undefined);
    },
    () => {},
  );
}
