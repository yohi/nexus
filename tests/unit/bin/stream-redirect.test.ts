import { lstat, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openBridgeStartupLog, redirectStreamToFd } from "../../../src/bin/stream-redirect.js";
import { loadConfig } from "../../../src/config/index.js";
import {
  openBridgeStartupCoordination,
  resolveStorageOwnershipTargets,
} from "../../../src/server/storage-ownership/index.js";

// Nexus #297 (Design §4.4 F-001): a managed child writes Bridge attempt logs only through a descriptor opened once,
// without O_CREAT and with O_NOFOLLOW, so it can never re-create or redirect a log after the Bridge removed it.

const fakeStream = () => {
  const write = vi.fn((_chunk: unknown, _encoding?: unknown, _callback?: unknown) => true);
  return { stream: { write } as unknown as NodeJS.WriteStream, write };
};
const exists = async (path: string): Promise<boolean> => lstat(path).then(() => true, () => false);

describe("Bridge startup log redirection", () => {
  let base: string;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "nexus-stream-redirect-")));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("bridge_removed_logs_never_reappear_after_child_writes", async () => {
    const targets = await resolveStorageOwnershipTargets(await loadConfig({ projectRoot: base, env: {} }));
    const coordination = await openBridgeStartupCoordination(targets);
    const logs = coordination.createAttemptLogs();
    const out = fakeStream();
    const err = fakeStream();
    const stdout = redirectStreamToFd(out.stream, openBridgeStartupLog(logs.stdoutPath));
    const stderr = redirectStreamToFd(err.stream, openBridgeStartupLog(logs.stderrPath));

    out.stream.write("before removal\n");
    err.stream.write(Buffer.from("refusal diagnostic\n"));
    expect(await readFile(logs.stdoutPath, "utf8")).toBe("before removal\n");
    expect(await readFile(logs.stderrPath, "utf8")).toBe("refusal diagnostic\n");

    logs.remove(); // Bridge: definite outcome, token-owned logs removed
    out.stream.write("managed HTTP server running\n"); // child keeps logging until detached
    err.stream.write("indexing progress\n");
    stdout.detach(); // child: Endpoint published
    stderr.detach();
    out.stream.write("after detach\n");
    err.stream.write("after detach\n");

    expect(await exists(logs.stdoutPath)).toBe(false);
    expect(await exists(logs.stderrPath)).toBe(false);
    expect((await readdir(coordination.logsDir)).filter((name) => name.startsWith(logs.token))).toEqual([]);
    // Normal stream behaviour is restored and every write still reached the original stream.
    expect(out.write).toHaveBeenCalledTimes(3);
    expect(err.write).toHaveBeenCalledTimes(3);
    expect(Object.prototype.hasOwnProperty.call(out.stream, "write")).toBe(true); // own vi.fn restored, not the tee
    expect(out.stream.write).toBe(out.write);
  });

  it("never creates a log file and refuses a symlinked or group-readable path", async () => {
    const missing = join(base, `${"a".repeat(32)}-stdout.log`);
    expect(() => openBridgeStartupLog(missing)).toThrow(expect.objectContaining({ code: "ENOENT" }));
    expect(await exists(missing)).toBe(false);

    const victim = join(base, "victim.log");
    await writeFile(victim, "victim bytes", { mode: 0o600 });
    const link = join(base, `${"b".repeat(32)}-stderr.log`);
    await symlink(victim, link);
    expect(() => openBridgeStartupLog(link)).toThrow(expect.objectContaining({ code: "ELOOP" }));
    expect(await readFile(victim, "utf8")).toBe("victim bytes");

    const shared = join(base, `${"c".repeat(32)}-stdout.log`);
    await writeFile(shared, "", { mode: 0o644 });
    expect(() => openBridgeStartupLog(shared)).toThrow("unsafe Bridge startup log");
  });

  it("detach is idempotent and closes the descriptor", async () => {
    const log = join(base, `${"d".repeat(32)}-stdout.log`);
    await writeFile(log, "", { mode: 0o600 });
    const out = fakeStream();
    const redirection = redirectStreamToFd(out.stream, openBridgeStartupLog(log));
    out.stream.write("x");
    redirection.detach();
    expect(() => redirection.detach()).not.toThrow();
    out.stream.write("y");
    expect(await readFile(log, "utf8")).toBe("x");
  });
});
