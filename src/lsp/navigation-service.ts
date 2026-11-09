import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Location, LocationLink } from 'vscode-languageserver-protocol';

import type { PathSanitizer } from '../server/path-sanitizer.js';
import { decodeUtf8, sha256Hex } from '../structured/hash.js';
import type { SymbolRetrievalService } from '../structured/retrieval-service.js';
import {
  LSP_NAVIGATION_INTERNAL_MAX_RESULTS,
  LSP_REFERENCES_DEFAULT_MAX_RESULTS,
  type ILspProvider,
  type LspNavigationKind,
  type NavigationResponse,
  type NavigationToolArgs,
  type VerifiedSymbolNavigationResult,
} from './contracts.js';
import type { LspProviderAcquisition } from './process-manager.js';
import {
  LspCapabilityUnsupportedError,
  LspRequestCancelledError,
  LspRequestTimeoutError,
  LspServerVersionMismatchError,
  LspSyncUnsupportedError,
} from './protocol-client.js';
import { validateNavigationResults } from './result-validator.js';
import {
  CanonicalSourceError,
  lspDocumentLanguageIdForPath,
  readCanonicalSource,
  resolveNavigationTarget,
  validateNavigationTargetArgs,
  type ResolvedNavigationTarget,
} from './target-resolver.js';

type NavigationSymbols = Pick<SymbolRetrievalService, 'resolveVerifiedNavigationTarget'>;

export interface LspNavigationServiceOptions {
  /** Canonical project root of the owning runtime; scopes every request lock to this worktree. */
  readonly projectRoot: string;
  readonly sanitizer: PathSanitizer;
  readonly symbols: NavigationSymbols;
  readonly isExcluded: (filePath: string) => boolean | Promise<boolean>;
  /** Runtime-local provider acquisition (production: `RuntimeLocalLspManager.acquire`). */
  readonly acquireProvider: (input: { signal?: AbortSignal }) => Promise<LspProviderAcquisition>;
  /** Bound for waiting on the runtime gate plus the per-URI lock (default 10000ms). */
  readonly lockTimeoutMs?: number;
}

export const LSP_NAVIGATION_DEFAULT_LOCK_TIMEOUT_MS = 10_000;

const LSP_NAVIGATION_LOCK_MARGIN_MS = 1_000;

/** A queued request must outlast one provider cold start plus one navigation request. */
export const lspNavigationLockTimeoutMs = (lsp: {
  readonly startupTimeoutMs: number;
  readonly requestTimeoutMs: number;
}): number =>
  Math.max(
    LSP_NAVIGATION_DEFAULT_LOCK_TIMEOUT_MS,
    lsp.startupTimeoutMs + lsp.requestTimeoutMs + LSP_NAVIGATION_LOCK_MARGIN_MS,
  );

type Status = NavigationResponse['status'];
type Capability = NavigationResponse['capability'];

const response = (
  status: Status,
  capability: Capability,
  reasonCode: string,
  reindexRequired?: boolean,
): NavigationResponse => ({
  status,
  capability,
  locations: [],
  truncated: false,
  sourceValidation: 'unknown',
  reasonCode,
  ...(reindexRequired === undefined ? {} : { reindexRequired }),
});

const CANCELLED = (capability: Capability): NavigationResponse => response('cancelled', capability, 'REQUEST_CANCELLED');

/** Function form so control-flow narrowing never assumes the signal state across awaits. */
const aborted = (signal?: AbortSignal): boolean => signal?.aborted === true;

const isAbortLike = (error: unknown, signal?: AbortSignal): boolean =>
  aborted(signal) ||
  error instanceof LspRequestCancelledError ||
  (error as Error | undefined)?.name === 'AbortError';

/** Maps any provider operation failure to a stable LSP-local outcome (never rethrows). */
const providerFailure = (error: unknown, signal?: AbortSignal): NavigationResponse => {
  if (isAbortLike(error, signal)) return CANCELLED('supported');
  if (error instanceof LspRequestTimeoutError) return response('timeout', 'supported', 'LSP_REQUEST_TIMEOUT');
  if (error instanceof LspSyncUnsupportedError) return response('unavailable', 'unavailable', 'LSP_SYNC_UNSUPPORTED');
  if (error instanceof LspServerVersionMismatchError) {
    return response('unavailable', 'unavailable', 'LSP_EXECUTABLE_NOT_APPROVED');
  }
  if (error instanceof LspCapabilityUnsupportedError) {
    return response('unsupported', 'unsupported', 'LSP_CAPABILITY_UNSUPPORTED');
  }
  // LspProtocolError and anything unexpected (including undefined lease failures) fail closed.
  return response('error', 'supported', 'LSP_PROTOCOL_ERROR');
};

// ---------------------------------------------------------------------------
// Bounded, cancellation-aware FIFO mutex

type LockOutcome = { status: 'ok'; release: () => void } | { status: 'timeout' | 'cancelled' };

class FifoMutex {
  private held = false;
  private readonly waiters: Array<() => void> = [];

  isIdle(): boolean {
    return !this.held && this.waiters.length === 0;
  }

  acquire(deadline: number, signal?: AbortSignal): Promise<LockOutcome> {
    if (aborted(signal)) return Promise.resolve({ status: 'cancelled' });
    if (!this.held) {
      this.held = true;
      return Promise.resolve({ status: 'ok', release: this.releaser() });
    }
    return new Promise<LockOutcome>((resolve) => {
      let settled = false;
      const cleanup = () => {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const index = this.waiters.indexOf(grant);
        if (index >= 0) this.waiters.splice(index, 1);
      };
      const grant = () => {
        if (settled) return;
        cleanup();
        resolve({ status: 'ok', release: this.releaser() });
      };
      const onAbort = () => {
        if (settled) return;
        cleanup();
        resolve({ status: 'cancelled' });
      };
      const timer = setTimeout(() => {
        if (settled) return;
        cleanup();
        resolve({ status: 'timeout' });
      }, Math.max(0, deadline - Date.now()));
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(grant);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next === undefined) {
        this.held = false;
        return;
      }
      // Ownership passes directly to the next waiter (FIFO); `held` stays true.
      next();
    };
  }
}

// ---------------------------------------------------------------------------

interface DiskIdentity {
  readonly uri: string;
  readonly filePath: string;
  readonly fileSha256: string;
}

type PreflightResult = { status: 'ok'; identities: DiskIdentity[] } | { status: 'failed'; response: NavigationResponse };
type OpenDocumentRefreshResult =
  | { readonly status: 'ok'; readonly identity: DiskIdentity }
  | { readonly status: 'failed'; readonly response: NavigationResponse };

/**
 * Runtime-local LSP navigation: target resolution against current disk, a request-level
 * transaction under a runtime navigation gate plus a per-URI exclusive lock, open-document
 * refresh, typed navigation, result validation and a final disk/generation recheck.
 *
 * The Protocol Client (Task 5) stays the sole owner of open-document text/version and
 * didOpen/didChange decisions; this service only supplies validated current disk text.
 */
export class LspNavigationService {
  private readonly projectRoot: string;
  private readonly sanitizer: PathSanitizer;
  private readonly symbols: NavigationSymbols;
  private readonly isExcluded: (filePath: string) => boolean | Promise<boolean>;
  private readonly acquireProvider: LspNavigationServiceOptions['acquireProvider'];
  private readonly lockTimeoutMs: number;

  /** Shared by every request using this runtime's Protocol Client (never cross-worktree). */
  private readonly gate = new FifoMutex();
  private readonly uriLocks = new Map<string, FifoMutex>();

  constructor(options: LspNavigationServiceOptions) {
    this.projectRoot = options.projectRoot;
    this.sanitizer = options.sanitizer;
    this.symbols = options.symbols;
    this.isExcluded = options.isExcluded;
    this.acquireProvider = options.acquireProvider;
    this.lockTimeoutMs =
      options.lockTimeoutMs !== undefined && Number.isFinite(options.lockTimeoutMs) && options.lockTimeoutMs > 0
        ? options.lockTimeoutMs
        : LSP_NAVIGATION_DEFAULT_LOCK_TIMEOUT_MS;
  }

  /**
   * Malformed arguments throw InvalidNavigationArgumentsError before any lock, symbol lookup or
   * provider acquisition; every runtime outcome is returned as a NavigationResponse.
   */
  async navigate(input: {
    kind: LspNavigationKind;
    args: NavigationToolArgs;
    signal?: AbortSignal;
  }): Promise<NavigationResponse> {
    validateNavigationTargetArgs(input.args);
    const { signal } = input;
    try {
      // Pre-lock: identify the canonical target URI only. This snapshot is never synchronized.
      const identified = await this.resolveTarget(input.args, signal);
      if (!('target' in identified)) return identified;
      return await this.underLocks(identified.target.uri, signal, () => this.transaction(input, identified.target.uri));
    } catch (error) {
      if (isAbortLike(error, signal)) return CANCELLED('not_checked');
      return response('error', 'not_checked', 'INVARIANT_VIOLATION');
    }
  }

  private async underLocks(
    uri: string,
    signal: AbortSignal | undefined,
    body: () => Promise<NavigationResponse>,
  ): Promise<NavigationResponse> {
    const deadline = Date.now() + this.lockTimeoutMs;
    const gate = await this.gate.acquire(deadline, signal);
    if (gate.status !== 'ok') return this.lockFailure(gate.status);
    const key = `${this.projectRoot}\0${uri}`;
    let lock = this.uriLocks.get(key);
    if (lock === undefined) {
      lock = new FifoMutex();
      this.uriLocks.set(key, lock);
    }
    try {
      const uriLock = await lock.acquire(deadline, signal);
      if (uriLock.status !== 'ok') return this.lockFailure(uriLock.status);
      try {
        return await body();
      } finally {
        uriLock.release();
      }
    } finally {
      if (lock.isIdle()) this.uriLocks.delete(key);
      gate.release();
    }
  }

  private lockFailure(status: 'timeout' | 'cancelled'): NavigationResponse {
    return status === 'cancelled'
      ? CANCELLED('not_checked')
      : response('timeout', 'not_checked', 'LSP_REQUEST_TIMEOUT');
  }

  /** The complete source -> sync -> navigate -> validate -> recheck transaction (both locks held). */
  private async transaction(
    input: { kind: LspNavigationKind; args: NavigationToolArgs; signal?: AbortSignal },
    lockedUri: string,
  ): Promise<NavigationResponse> {
    const { signal } = input;
    if (aborted(signal)) return CANCELLED('not_checked');

    const prepared = await this.prepareTransaction(input, lockedUri);
    if ('response' in prepared) return prepared.response;
    const raw = await this.runNavigation(input, prepared.provider, prepared.target);
    if (raw !== null && 'status' in raw) return raw;
    return this.validateAndRecheck(input, prepared, raw);
  }

  private async prepareTransaction(
    input: { kind: LspNavigationKind; args: NavigationToolArgs; signal?: AbortSignal },
    lockedUri: string,
  ): Promise<
    | { readonly response: NavigationResponse }
    | {
        readonly provider: ILspProvider;
        readonly identities: readonly DiskIdentity[];
        readonly target: ResolvedNavigationTarget;
        readonly verifiedSymbol: VerifiedSymbolNavigationResult | undefined;
        readonly isSymbol: boolean;
      }
  > {
    const acquisition = await this.safeAcquire(input.signal);
    if (acquisition.status !== 'ok') {
      return { response: response(acquisition.status, acquisition.status === 'unavailable' ? 'unavailable' : 'not_checked', acquisition.reasonCode) };
    }
    if (!acquisition.capabilities[input.kind]) {
      return { response: response('unsupported', 'unsupported', 'LSP_CAPABILITY_UNSUPPORTED') };
    }
    const preflight = await this.refreshOpenDocuments(acquisition.provider, lockedUri, input.signal);
    if (preflight.status !== 'ok') return { response: preflight.response };

    let verifiedSymbol: VerifiedSymbolNavigationResult | undefined;
    const recording: NavigationSymbols = {
      resolveVerifiedNavigationTarget: async (request) => {
        verifiedSymbol = await this.symbols.resolveVerifiedNavigationTarget(request);
        return verifiedSymbol;
      },
    };
    const resolved = await this.resolveTarget(input.args, input.signal, recording);
    if (!('target' in resolved)) return { response: resolved };
    const isSymbol = input.args.symbolId !== undefined;
    if (resolved.target.uri !== lockedUri) {
      return { response: response('stale', 'supported', 'INDEX_FILE_HASH_MISMATCH', isSymbol || undefined) };
    }
    if (aborted(input.signal)) return { response: CANCELLED('supported') };
    return {
      provider: acquisition.provider,
      identities: preflight.identities,
      target: resolved.target,
      verifiedSymbol,
      isSymbol,
    };
  }

  private async runNavigation(
    input: { kind: LspNavigationKind; args: NavigationToolArgs; signal?: AbortSignal },
    provider: ILspProvider,
    target: ResolvedNavigationTarget,
  ): Promise<null | readonly (Location | LocationLink)[] | NavigationResponse> {
    try {
      await provider.syncDocument({ uri: target.uri, languageId: target.languageId, text: target.text });
      if (aborted(input.signal)) return CANCELLED('supported');
      const raw = await provider.navigate({ kind: input.kind, uri: target.uri, position: target.position, signal: input.signal });
      return aborted(input.signal) ? CANCELLED('supported') : raw;
    } catch (error) {
      return providerFailure(error, input.signal);
    }
  }

  private async validateAndRecheck(
    input: { kind: LspNavigationKind; args: NavigationToolArgs; signal?: AbortSignal },
    prepared: {
      readonly target: ResolvedNavigationTarget;
      readonly identities: readonly DiskIdentity[];
      readonly verifiedSymbol: VerifiedSymbolNavigationResult | undefined;
      readonly isSymbol: boolean;
    },
    raw: null | readonly (Location | LocationLink)[],
  ): Promise<NavigationResponse> {
    if (input.kind === 'references' && !isReferencesShape(raw)) {
      return response('error', 'supported', 'LSP_PROTOCOL_ERROR');
    }
    const validated = await validateNavigationResults({
      raw,
      sanitizer: this.sanitizer,
      isExcluded: this.isExcluded,
      maxResults: input.kind === 'references'
        ? (input.args.maxResults ?? LSP_REFERENCES_DEFAULT_MAX_RESULTS)
        : LSP_NAVIGATION_INTERNAL_MAX_RESULTS,
      signal: input.signal,
    });
    if ('status' in validated) return response(validated.status, 'supported', validated.reasonCode);
    const recheck = await this.recheckIdentities(
      prepared.target,
      prepared.isSymbol ? prepared.verifiedSymbol : undefined,
      prepared.identities,
      input.signal,
    );
    if (recheck !== null) return recheck;
    return {
      status: 'ok',
      capability: 'supported',
      locations: validated.locations,
      truncated: validated.truncated,
      sourceValidation: validated.sourceValidation,
      ...(validated.excludedResultCount !== undefined && validated.excludedResultCount > 0
        ? { excludedResultCount: validated.excludedResultCount }
        : {}),
    };
  }

  private async resolveTarget(
    args: NavigationToolArgs,
    signal: AbortSignal | undefined,
    symbols: NavigationSymbols = this.symbols,
  ): Promise<{ status: 'ok'; target: ResolvedNavigationTarget } | NavigationResponse> {
    return resolveNavigationTarget({
      args,
      // resolveNavigationTarget only uses resolveVerifiedNavigationTarget.
      symbols: symbols as SymbolRetrievalService,
      sanitizer: this.sanitizer,
      isExcluded: this.isExcluded,
      signal,
    });
  }

  private async safeAcquire(signal?: AbortSignal): Promise<LspProviderAcquisition> {
    try {
      return await this.acquireProvider({ signal });
    } catch (error) {
      if (isAbortLike(error, signal)) return { status: 'cancelled', reasonCode: 'REQUEST_CANCELLED' };
      return { status: 'error', reasonCode: 'LSP_PROTOCOL_ERROR' };
    }
  }

  /**
   * Re-reads every other open document from current disk (stable URI order) and hands its text
   * to the Protocol Client, which suppresses unchanged notifications. An unsafe/unreadable open
   * document is closed and aborts this navigation; a failed sync/close fails closed.
   */
  private async refreshOpenDocuments(
    provider: ILspProvider,
    targetUri: string,
    signal?: AbortSignal,
  ): Promise<PreflightResult> {
    const openUris = this.sortedOpenUris(provider, signal);
    if ('status' in openUris) return { status: 'failed', response: openUris.response };
    const identities: DiskIdentity[] = [];
    for (const uri of openUris.uris) {
      if (uri === targetUri) continue;
      const refreshed = await this.refreshOpenDocument(provider, uri, signal);
      if (refreshed.status !== 'ok') return refreshed;
      identities.push(refreshed.identity);
    }
    return { status: 'ok', identities };
  }

  private sortedOpenUris(
    provider: ILspProvider,
    signal?: AbortSignal,
  ): { readonly uris: string[] } | { readonly status: 'failed'; readonly response: NavigationResponse } {
    try {
      return { uris: [...provider.listOpenDocumentUris()].sort((left, right) => left.localeCompare(right)) };
    } catch (error) {
      return { status: 'failed', response: providerFailure(error, signal) };
    }
  }

  private async refreshOpenDocument(
    provider: ILspProvider,
    uri: string,
    signal?: AbortSignal,
  ): Promise<OpenDocumentRefreshResult> {
    if (aborted(signal)) return { status: 'failed', response: CANCELLED('supported') };
    const current = await this.readOpenDocument(uri, signal);
    if (current.status === 'cancelled') return { status: 'failed', response: CANCELLED('supported') };
    if (current.status === 'failed') {
      try {
        await provider.closeDocument({ uri });
      } catch (error) {
        return { status: 'failed', response: providerFailure(error, signal) };
      }
      return { status: 'failed', response: current.response };
    }
    try {
      await provider.syncDocument({ uri, languageId: current.languageId, text: current.text });
    } catch (error) {
      return { status: 'failed', response: providerFailure(error, signal) };
    }
    return { status: 'ok', identity: { uri, filePath: current.filePath, fileSha256: current.fileSha256 } };
  }

  private async readOpenDocument(
    uri: string,
    signal?: AbortSignal,
  ): Promise<
    | {
        status: 'ok';
        filePath: string;
        text: string;
        fileSha256: string;
        languageId: NonNullable<ReturnType<typeof lspDocumentLanguageIdForPath>>;
      }
    | { status: 'cancelled' }
    | { status: 'failed'; response: NavigationResponse }
  > {
    const unsafe = { status: 'failed' as const, response: response('stale', 'supported', 'INDEX_FILE_HASH_MISMATCH') };
    const relative = this.relativePathForUri(uri);
    if (relative === null) return unsafe;
    try {
      const snapshot = await readCanonicalSource({
        filePath: relative,
        sanitizer: this.sanitizer,
        isExcluded: this.isExcluded,
        signal,
      });
      // The tracked URI must still be the canonical identity of the file (no swapped alias).
      if (snapshot.uri !== uri) return unsafe;
      const languageId = lspDocumentLanguageIdForPath(snapshot.filePath);
      if (languageId === null) return unsafe;
      const text = decodeUtf8(snapshot.bytes);
      return { status: 'ok', filePath: snapshot.filePath, text, fileSha256: sha256Hex(snapshot.bytes), languageId };
    } catch (error) {
      if (isAbortLike(error, signal)) return { status: 'cancelled' };
      if (error instanceof CanonicalSourceError && error.failure === 'missing') {
        return { status: 'failed', response: response('stale', 'supported', 'INDEX_FILE_MISSING') };
      }
      return unsafe;
    }
  }

  private relativePathForUri(uri: string): string | null {
    let absolutePath: string;
    try {
      const url = new URL(uri);
      if (url.protocol !== 'file:' || url.search !== '' || url.hash !== '') return null;
      if (url.host !== '' && url.host !== 'localhost') return null;
      absolutePath = fileURLToPath(url);
    } catch {
      return null;
    }
    const relative = path.relative(this.sanitizer.getProjectRoot(), absolutePath);
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return null;
    }
    return relative.split(path.sep).join('/');
  }

  /**
   * Final in-lock check before publishing: target bytes (and active generation/identity for a
   * symbolId) and every refreshed open document must still match the snapshots used.
   */
  private async recheckIdentities(
    target: ResolvedNavigationTarget,
    verifiedSymbol: VerifiedSymbolNavigationResult | undefined,
    identities: readonly DiskIdentity[],
    signal?: AbortSignal,
  ): Promise<NavigationResponse | null> {
    const symbolTarget = verifiedSymbol?.status === 'ok' ? verifiedSymbol.target : undefined;
    const reindexRequired = symbolTarget !== undefined ? true : undefined;
    const stale = response('stale', 'supported', 'INDEX_FILE_HASH_MISMATCH', reindexRequired);
    try {
      for (const identity of [{ uri: target.uri, filePath: target.filePath, fileSha256: target.fileSha256 }, ...identities]) {
        const current = await this.currentHash(identity.filePath, signal);
        if (current !== identity.fileSha256) return stale;
      }
      if (symbolTarget !== undefined) {
        const again = await this.symbols.resolveVerifiedNavigationTarget({ symbolId: symbolTarget.symbolId, signal });
        if (again.status !== 'ok') {
          return response(again.status, 'supported', again.reasonCode, again.reindexRequired);
        }
        if (
          again.target.generationId !== symbolTarget.generationId ||
          again.target.fileSha256 !== symbolTarget.fileSha256 ||
          again.target.filePath !== symbolTarget.filePath ||
          again.target.position.line !== symbolTarget.position.line ||
          again.target.position.character !== symbolTarget.position.character
        ) {
          return stale;
        }
      }
    } catch (error) {
      if (isAbortLike(error, signal)) return CANCELLED('supported');
      return response('error', 'supported', 'INVARIANT_VIOLATION');
    }
    if (aborted(signal)) return CANCELLED('supported');
    return null;
  }

  /** Current canonical SHA-256, or null when unreadable/refused; cancellation propagates. */
  private async currentHash(filePath: string, signal?: AbortSignal): Promise<string | null> {
    try {
      const snapshot = await readCanonicalSource({
        filePath,
        sanitizer: this.sanitizer,
        isExcluded: this.isExcluded,
        signal,
      });
      return sha256Hex(snapshot.bytes);
    } catch (error) {
      if (isAbortLike(error, signal)) throw error;
      return null;
    }
  }
}

/** `textDocument/references` may only reply `null` or `Location[]` (never LocationLink). */
const isReferencesShape = (raw: unknown): boolean =>
  raw === null ||
  (Array.isArray(raw) &&
    raw.every((entry) => typeof entry === 'object' && entry !== null && !('targetUri' in entry)));
