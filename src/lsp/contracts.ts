import type { Location, LocationLink } from 'vscode-languageserver-protocol';

export type LspNavigationKind = 'definition' | 'references' | 'implementations';

// LSP text-document IDs are distinct from the Structured Catalog's parser/language IDs.
export type LspDocumentLanguageId =
  | 'typescript'
  | 'typescriptreact'
  | 'javascript'
  | 'javascriptreact';

export interface LspCapabilities {
  definition: boolean;
  references: boolean;
  implementations: boolean;
  positionEncoding: 'utf-16';
}

export interface ILspProvider {
  start(input: {
    rootUri: string;
    /** Passed from Owner-approved ApprovedLspLaunch.serverVersion. */
    expectedServerVersion: '6.0.2';
    signal?: AbortSignal;
  }): Promise<LspCapabilities>;
  /** The caller supplies validated current disk text; the Protocol Client owns kind/version. */
  syncDocument(input: {
    uri: string;
    languageId: LspDocumentLanguageId;
    text: string;
  }): Promise<void>;
  closeDocument(input: { uri: string }): Promise<void>;
  /** Read-only snapshot of open URIs (no text/version; Protocol Client stays sole state owner). */
  listOpenDocumentUris(): readonly string[];
  navigate(input: {
    kind: LspNavigationKind;
    uri: string;
    position: { line: number; character: number }; // LSP 0-based UTF-16
    signal?: AbortSignal;
  }): Promise<null | readonly (Location | LocationLink)[]>;
  shutdown(): Promise<void>;
}

export interface NavigationToolArgs {
  symbolId?: string;
  filePath?: string;
  line?: number; // 1-based
  character?: number; // 0-based UTF-16 code units; 0 is valid
  maxResults?: number; // only meaningful for references; optional bounded default
}

export interface NavigationLocation {
  filePath: string; // validated, project-relative
  startLine: number; // 1-based
  startCharacter: number; // 0-based UTF-16
  endLine: number;
  endCharacter: number;
}

export interface NavigationResponse {
  status:
    | 'ok'
    | 'not_found'
    | 'stale_identity'
    | 'stale'
    | 'index_incomplete'
    | 'not_indexed'
    | 'degraded'
    | 'excluded'
    | 'unsupported'
    | 'unavailable'
    | 'timeout'
    | 'cancelled'
    | 'error';
  capability: 'supported' | 'unsupported' | 'unavailable' | 'not_checked';
  locations: NavigationLocation[];
  truncated: boolean;
  sourceValidation: 'verified' | 'partial' | 'unknown';
  reasonCode?: string;
  excludedResultCount?: number;
  reindexRequired?: boolean;
}

export interface VerifiedSymbolNavigationTarget {
  readonly symbolId: string;
  readonly filePath: string; // normalized project-relative
  readonly languageId: 'typescript' | 'javascript'; // Structured Catalog ID, NOT LSP document languageId
  readonly position: {
    readonly line: number; // Nexus 1-based
    readonly character: number; // UTF-16, 0-based
  };
  readonly fileSha256: string;
  readonly generationId: string;
}

export type VerifiedSymbolNavigationResult =
  | { readonly status: 'ok'; readonly target: VerifiedSymbolNavigationTarget }
  | {
      readonly status:
        | 'stale_identity'
        | 'stale'
        | 'not_found'
        | 'not_indexed'
        | 'index_incomplete'
        | 'excluded'
        | 'unsupported'
        | 'degraded'
        | 'error'
        | 'cancelled';
      readonly reasonCode: string;
      readonly reindexRequired: boolean;
    };

/** Stable internal bound for definition/implementation results (explicit `truncated` on overflow). */
export const LSP_NAVIGATION_INTERNAL_MAX_RESULTS = 100;
export const LSP_REFERENCES_DEFAULT_MAX_RESULTS = 100;
export const LSP_REFERENCES_MAX_RESULTS = 1000;
