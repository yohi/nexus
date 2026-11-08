import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, open, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { LspConfig } from '../types/index.js';

export type ApprovedLspLaunch = {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly serverVersion: '6.0.2';
};

export type LspLaunchDecision =
  | { readonly status: 'ok'; readonly launch: ApprovedLspLaunch }
  | {
      readonly status: 'unavailable';
      readonly reasonCode:
        | 'LSP_CONFIG_INVALID'
        | 'LSP_NOT_CONFIGURED'
        | 'LSP_TRUST_REQUIRED'
        | 'LSP_EXECUTABLE_NOT_APPROVED';
    };

const APPROVED_SERVER_VERSION = '6.0.2';
const SAFE_SYSTEM_PATH_DIRS = ['/usr/local/bin', '/usr/bin', '/bin'];
const ALLOWED_ENV_NAMES = ['HOME', 'TMPDIR', 'LANG', 'LC_ALL'] as const;

type Reason = Extract<LspLaunchDecision, { status: 'unavailable' }>['reasonCode'];

const deny = (reasonCode: Reason): LspLaunchDecision => ({ status: 'unavailable', reasonCode });

interface TrustApproval {
  projectRoot: unknown;
  executable?: unknown;
  executableSha256?: unknown;
  args?: unknown;
  serverVersion?: unknown;
}

/**
 * Resolves an Owner-approved LSP launch. Reads the owner-controlled trust store only;
 * never writes approvals, probes versions, consults PATH, or spawns a process.
 */
export async function resolveApprovedLspLaunch(input: {
  projectRoot: string;
  lsp: LspConfig;
  env: NodeJS.ProcessEnv;
  configError?: 'LSP_CONFIG_INVALID';
}): Promise<LspLaunchDecision> {
  if (input.configError !== undefined) return deny('LSP_CONFIG_INVALID');
  const { lsp } = input;
  const configured = lsp.typescript.executable;
  if (!lsp.enabled || configured === null) return deny('LSP_NOT_CONFIGURED');

  // Windows owner-only ACL verification is not implemented: fail closed.
  if (process.platform === 'win32') return deny('LSP_TRUST_REQUIRED');

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(input.projectRoot);
  } catch {
    return deny('LSP_TRUST_REQUIRED');
  }

  const approvals = await readTrustedApprovals(input.env, canonicalRoot);
  if (approvals === null) return deny('LSP_TRUST_REQUIRED');
  const rootApprovals = approvals.filter((entry) => entry.projectRoot === canonicalRoot);
  if (rootApprovals.length === 0) return deny('LSP_TRUST_REQUIRED');

  const canonicalExecutable = await canonicalExecutablePath(configured);
  if (canonicalExecutable === null) return deny('LSP_EXECUTABLE_NOT_APPROVED');

  let digest: string;
  try {
    digest = createHash('sha256').update(await readFile(canonicalExecutable)).digest('hex');
  } catch {
    return deny('LSP_EXECUTABLE_NOT_APPROVED');
  }

  const args = lsp.typescript.args;
  const approved = rootApprovals.some(
    (entry) =>
      entry.executable === canonicalExecutable &&
      entry.executableSha256 === digest &&
      Array.isArray(entry.args) &&
      entry.args.length === args.length &&
      entry.args.every((value, index) => value === args[index]) &&
      entry.serverVersion === APPROVED_SERVER_VERSION,
  );
  if (!approved) return deny('LSP_EXECUTABLE_NOT_APPROVED');

  return {
    status: 'ok',
    launch: {
      executable: canonicalExecutable,
      args: [...args],
      cwd: canonicalRoot,
      env: buildChildEnv(input.env),
      serverVersion: APPROVED_SERVER_VERSION,
    },
  };
}

async function canonicalExecutablePath(configured: string): Promise<string | null> {
  if (!path.isAbsolute(configured)) return null;
  try {
    const canonical = await realpath(configured);
    if (!(await stat(canonical)).isFile()) return null;
    await access(canonical, constants.X_OK);
    return canonical;
  } catch {
    return null;
  }
}

function buildChildEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ALLOWED_ENV_NAMES) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  env.PATH = [path.dirname(process.execPath), ...SAFE_SYSTEM_PATH_DIRS].join(path.delimiter);
  return env;
}

function trustStorePath(env: NodeJS.ProcessEnv): string | null {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg !== '' && path.isAbsolute(xdg)) {
    return path.join(xdg, 'nexus', 'lsp-trust.json');
  }
  const home = env.HOME;
  if (home !== undefined && home !== '' && path.isAbsolute(home)) {
    return path.join(home, '.config', 'nexus', 'lsp-trust.json');
  }
  return null;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Returns parsed approvals, or null for any missing/unreadable/unsafe trust data. */
async function readTrustedApprovals(env: NodeJS.ProcessEnv, canonicalRoot: string): Promise<TrustApproval[] | null> {
  const storePath = trustStorePath(env);
  const uid = process.getuid?.();
  if (storePath === null || uid === undefined) return null;

  try {
    // Parents: no symlink components, owned by current user or root, not group/world-writable
    // (sticky world-writable system directories such as /tmp are tolerated).
    const dir = path.dirname(storePath);
    if ((await realpath(dir)) !== path.resolve(dir)) return null;
    for (let current = dir; ; current = path.dirname(current)) {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) return null;
      if (info.uid !== uid && info.uid !== 0) return null;
      const writableByOthers = (info.mode & 0o022) !== 0;
      if (writableByOthers && (info.mode & 0o1000) === 0) return null;
      if (current === path.dirname(current)) break;
    }
    if (isInside(canonicalRoot, dir)) return null;

    const fileInfo = await lstat(storePath);
    if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) return null;
    if (fileInfo.uid !== uid || (fileInfo.mode & 0o777) !== 0o600) return null;

    const handle = await open(storePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let raw: string;
    try {
      raw = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const { version, approvals } = parsed as { version?: unknown; approvals?: unknown };
    if (version !== 1 || !Array.isArray(approvals)) return null;
    return approvals.filter(
      (entry): entry is TrustApproval => entry !== null && typeof entry === 'object' && !Array.isArray(entry),
    );
  } catch {
    return null;
  }
}
