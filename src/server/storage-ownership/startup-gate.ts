// Bridge-side startup coordination (Nexus #297, Design §4.4 F-001). Internal only; not a public API.
//
// The HTTP Bridge is a discovery-only client: it never mkdirs, writes or deletes anything under an unadmitted Storage
// Root and never acquires a WriterAdmission. To serialize managed spawn requests even when the Storage Root does not
// exist yet, it uses a kernel-backed startup gate and per-attempt logs that live only in the trusted, account-private
// coordination root:
//   <coordinationRoot>/startup/<sha256(ownerProjectRoot)>.lock
//   <coordinationRoot>/startup-logs/<token>-{stdout,stderr}.log
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { processCoordinationRoot, StorageOwnershipError } from './admission.js';
import { coordinationRootPath, ensurePrivateDirectory, prepareCoordinationRoot, sqliteFcntlLockBackend, type KernelLock, type KernelLockBackend } from './claims.js';
import type { ResolvedStorageOwnershipTargets } from './types.js';

export const STARTUP_LOCK_DIR = 'startup';
export const STARTUP_LOGS_DIR = 'startup-logs';
/**
 * Internal-only spawn channel (never a CLI flag, MCP parameter or config setting): the Bridge passes the fingerprint of
 * the targets it inspected; the managed child refuses before admission when its own fresh targets differ. Fail-fast
 * diagnostic only, never authorization.
 */
export const INTERNAL_TARGETS_FINGERPRINT_ENV = 'NEXUS_INTERNAL_STORAGE_TARGETS_FINGERPRINT';

const LOG_NAME_PATTERN = /^[0-9a-f]{32}-(stdout|stderr)\.log$/;
const DEFAULT_ATTEMPT_LOG_BYTES = 64 * 1024;

export function startupGateKey(ownerProjectRoot: string): string {
  return createHash('sha256').update(ownerProjectRoot).digest('hex');
}

export interface StartupAttemptLogs {
  readonly token: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  /** Removes only the two token-owned files created by this attempt (verified regular files owned by this account). */
  readonly remove: () => void;
}

export interface BridgeStartupCoordination {
  readonly coordinationRoot: string;
  readonly gatePath: string;
  readonly logsDir: string;
  /** Nonblocking: `null` while another Bridge holds the gate. Throws if no verifiable kernel lock is available. */
  readonly tryAcquireGate: () => KernelLock | null;
  readonly createAttemptLogs: () => StartupAttemptLogs;
}

export interface BridgeStartupCoordinationOptions {
  readonly coordinationRoot?: string;
  readonly lockBackend?: KernelLockBackend;
}

function removeOwnedLog(path: string): void {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (!stat.isFile() || stat.uid !== process.getuid?.()) return; // not ours: retain for owner-directed cleanup
  try { unlinkSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

function createPrivateLog(path: string): void {
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  closeSync(fd);
}

/**
 * Verify/create the coordination root plus its `startup/` and `startup-logs/` private directories. Never touches any
 * storage target; refuses when the coordination root overlaps a configured persistent target.
 */
export async function openBridgeStartupCoordination(
  targets: ResolvedStorageOwnershipTargets,
  options: BridgeStartupCoordinationOptions = {},
): Promise<BridgeStartupCoordination> {
  const persistent = [targets.rootDir.path, targets.metadataDbPath.path];
  if (targets.vectorDbPath.kind === 'persistent') persistent.push(targets.vectorDbPath.path);
  const backend = options.lockBackend ?? sqliteFcntlLockBackend;
  let root: string;
  try {
    root = await prepareCoordinationRoot(options.coordinationRoot ?? await processCoordinationRoot(), persistent);
    const uid = process.getuid?.() ?? -1;
    const pinnedRoot = coordinationRootPath(root);
    await ensurePrivateDirectory(join(pinnedRoot, STARTUP_LOCK_DIR), uid, join(root, STARTUP_LOCK_DIR));
    await ensurePrivateDirectory(join(pinnedRoot, STARTUP_LOGS_DIR), uid, join(root, STARTUP_LOGS_DIR));
  } catch (error) {
    throw new StorageOwnershipError('lock_unavailable', `coordination root unusable: ${(error as Error).message}`, { cause: error });
  }
  const pinnedRoot = coordinationRootPath(root);
  const gatePath = join(pinnedRoot, STARTUP_LOCK_DIR, `${startupGateKey(targets.ownerProjectRoot)}.lock`);
  const logsDir = join(root, STARTUP_LOGS_DIR);
  const pinnedLogsDir = join(pinnedRoot, STARTUP_LOGS_DIR);

  return {
    coordinationRoot: root,
    gatePath,
    logsDir,
    tryAcquireGate: () => {
      let lock: KernelLock | null;
      try { lock = backend.tryAcquire(gatePath); }
      catch (error) { throw new StorageOwnershipError('lock_unavailable', 'startup gate lock failed', { cause: error }); }
      if (lock && !lock.isHeld()) {
        lock.release();
        throw new StorageOwnershipError('unsupported_kernel_lease', `backend ${backend.name} provided no verifiable startup gate`);
      }
      return lock;
    },
    createAttemptLogs: () => {
      const token = randomBytes(16).toString('hex');
      const stdoutPath = join(logsDir, `${token}-stdout.log`);
      const stderrPath = join(logsDir, `${token}-stderr.log`);
      const pinnedStdoutPath = join(pinnedLogsDir, `${token}-stdout.log`);
      const pinnedStderrPath = join(pinnedLogsDir, `${token}-stderr.log`);
      createPrivateLog(pinnedStdoutPath);
      try { createPrivateLog(pinnedStderrPath); }
      catch (error) { removeOwnedLog(pinnedStdoutPath); throw error; }
      return {
        token, stdoutPath, stderrPath,
        remove: () => { removeOwnedLog(pinnedStdoutPath); removeOwnedLog(pinnedStderrPath); },
      };
    },
  };
}

/** Read a token-owned attempt log (bounded by the caller). Missing file reads as empty. */
export function readAttemptLog(path: string, maxBytes = DEFAULT_ATTEMPT_LOG_BYTES): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY);
    const size = fstatSync(fd).size;
    const bytesToRead = Math.min(size, Math.max(0, maxBytes) + 3);
    const buffer = Buffer.alloc(bytesToRead);
    const bytesRead = readSync(fd, buffer, 0, bytesToRead, Math.max(0, size - bytesToRead));
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const characters = Array.from(text);
    let start = characters.length;
    let totalBytes = 0;
    for (let index = characters.length - 1; index >= 0; index -= 1) {
      const charBytes = Buffer.byteLength(characters[index] ?? '', 'utf8');
      if (totalBytes + charBytes > maxBytes) break;
      totalBytes += charBytes;
      start = index;
    }
    return characters.slice(start).join('');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Child side: whether a startup log path is a Bridge attempt log in the coordination root (so it may be opened before
 * writer admission without writing anything under Storage).
 */
export async function isBridgeStartupLogPath(path: string): Promise<boolean> {
  const absolute = resolve(path);
  if (!LOG_NAME_PATTERN.test(basename(absolute))) return false;
  let root: string;
  try { root = await processCoordinationRoot(); } catch { return false; }
  return dirname(absolute) === join(root, STARTUP_LOGS_DIR);
}

/**
 * Child side, before admission: compare the Bridge-inspected fingerprint (if any) with the child's own freshly resolved
 * targets. A mismatch refuses early. A match authorizes nothing; `admitStorageWriter()` still runs in full.
 */
export function assertExpectedStorageTargetsFingerprint(actualFingerprint: string, expected: string | undefined): void {
  if (expected === undefined || expected === '') return;
  if (expected !== actualFingerprint) {
    throw new StorageOwnershipError('target_mismatch', 'effective storage targets changed since the Bridge preflight');
  }
}
