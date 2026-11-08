import type { NeutralSchema } from './schemas-neutral.js';

export type ToolName =
  | 'semantic_search'
  | 'grep_search'
  | 'hybrid_search'
  | 'get_context'
  | 'index_status'
  | 'reindex'
  | 'get_file_outline'
  | 'get_symbol_source'
  | 'get_symbol_context'
  | 'get_definition'
  | 'get_references'
  | 'get_implementations';

export interface ToolDefinition {
  name: ToolName;
  description: string;
  input: NeutralSchema;
}

export const SEMANTIC_SEARCH_DEFINITION: ToolDefinition = {
  name: 'semantic_search',
  description: 'Vector-only semantic search; prefer hybrid_search for most tasks.',
  input: {
    query: { kind: 'string' },
    topK: { kind: 'integer', optional: true, maximum: 100 },
    filePattern: { kind: 'string', optional: true },
    filePatterns: { kind: 'stringArray', optional: true },
    language: { kind: 'string', optional: true },
  },
};

export const GREP_SEARCH_DEFINITION: ToolDefinition = {
  name: 'grep_search',
  description: 'Exact string search for symbols, errors, or code fragments.',
  input: {
    pattern: { kind: 'string' },
    filePattern: { kind: 'string', optional: true },
    filePatterns: { kind: 'stringArray', optional: true },
    caseSensitive: { kind: 'boolean', optional: true },
    maxResults: { kind: 'integer', optional: true, maximum: 1000 },
  },
};

export const HYBRID_SEARCH_DEFINITION: ToolDefinition = {
  name: 'hybrid_search',
  description: 'Semantic + grep hybrid search for vague or conceptual queries.',
  input: {
    query: { kind: 'string' },
    topK: { kind: 'integer', optional: true, maximum: 100 },
    filePattern: { kind: 'string', optional: true },
    filePatterns: { kind: 'stringArray', optional: true },
    language: { kind: 'string', optional: true },
    grepPattern: { kind: 'string', optional: true },
    includeSnippet: { kind: 'boolean', optional: true },
    contextLines: {
      kind: 'integer',
      optional: true,
      maximum: 20,
      description:
        'Lines of context to include before and after each match when includeSnippet is true. Maximum 20; values above 20 are rejected.',
    },
  },
};

export const GET_CONTEXT_DEFINITION: ToolDefinition = {
  name: 'get_context',
  description: 'Return a specific line range from a file; prefer partial reads.',
  input: {
    filePath: { kind: 'string' },
    symbolName: { kind: 'string', optional: true },
    startLine: { kind: 'integer', optional: true },
    endLine: { kind: 'integer', optional: true },
    mode: {
      kind: 'enum',
      values: ['eager', 'deferred'],
      optional: true,
      default: 'eager',
      description:
        'Set to "deferred" to receive a short preview and hint instead of full content for large files.',
    },
  },
};

export const INDEX_STATUS_DEFINITION: ToolDefinition = {
  name: 'index_status',
  description: 'Check indexing progress and statistics before searching.',
  input: {},
};

export const REINDEX_DEFINITION: ToolDefinition = {
  name: 'reindex',
  description: 'Manually rebuild the local search index.',
  input: {
    fullRebuild: { kind: 'boolean', optional: true },
    reason: {
      kind: 'enum',
      values: ['manual', 'overflow-recovery', 'startup-reconciliation'],
      optional: true,
    },
  },
};

export const GET_FILE_OUTLINE_DEFINITION: ToolDefinition = {
  name: 'get_file_outline',
  description: 'Return a source-free structured outline of a known file.',
  input: {
    filePath: { kind: 'string' },
  },
};

export const GET_SYMBOL_SOURCE_DEFINITION: ToolDefinition = {
  name: 'get_symbol_source',
  description: 'Return exact source for a structured symbol ID.',
  input: {
    symbolId: { kind: 'string', pattern: '^symbol_v1_[A-Za-z0-9_-]{43}$' },
  },
};

export const GET_SYMBOL_CONTEXT_DEFINITION: ToolDefinition = {
  name: 'get_symbol_context',
  description: 'Return bounded context (verified imports + exact symbol source) for a symbol ID.',
  input: {
    symbolId: { kind: 'string', pattern: '^symbol_v1_[A-Za-z0-9_-]{43}$' },
    tokenBudget: { kind: 'integer', minimum: 1, maximum: 100000 },
  },
};

const NAVIGATION_TARGET_INPUT: NeutralSchema = {
  symbolId: {
    kind: 'string',
    optional: true,
    pattern: '^symbol_v1_[A-Za-z0-9_-]{43}$',
    description: 'Structured symbol ID. Provide either symbolId alone or filePath + line + character.',
  },
  filePath: {
    kind: 'string',
    optional: true,
    description: 'Project-relative file path (requires line and character).',
  },
  line: { kind: 'integer', optional: true, minimum: 1, description: '1-based line number.' },
  character: {
    kind: 'integer',
    optional: true,
    minimum: 0,
    description: '0-based UTF-16 code-unit offset within the line; 0 is valid.',
  },
};

export const GET_DEFINITION_DEFINITION: ToolDefinition = {
  name: 'get_definition',
  description: 'Return live LSP definition locations for a symbolId or file position (TS/JS).',
  input: { ...NAVIGATION_TARGET_INPUT },
};

export const GET_REFERENCES_DEFINITION: ToolDefinition = {
  name: 'get_references',
  description: 'Return live LSP reference locations for a symbolId or file position (TS/JS).',
  input: {
    ...NAVIGATION_TARGET_INPUT,
    maxResults: {
      kind: 'integer',
      optional: true,
      minimum: 1,
      maximum: 1000,
      hardMaximum: true,
      description: 'Maximum references to return (default 100, maximum 1000); see truncated.',
    },
  },
};

export const GET_IMPLEMENTATIONS_DEFINITION: ToolDefinition = {
  name: 'get_implementations',
  description: 'Return live LSP implementation locations for a symbolId or file position (TS/JS).',
  input: { ...NAVIGATION_TARGET_INPUT },
};

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  SEMANTIC_SEARCH_DEFINITION,
  GREP_SEARCH_DEFINITION,
  HYBRID_SEARCH_DEFINITION,
  GET_CONTEXT_DEFINITION,
  INDEX_STATUS_DEFINITION,
  REINDEX_DEFINITION,
  GET_FILE_OUTLINE_DEFINITION,
  GET_SYMBOL_SOURCE_DEFINITION,
  GET_SYMBOL_CONTEXT_DEFINITION,
  GET_DEFINITION_DEFINITION,
  GET_REFERENCES_DEFINITION,
  GET_IMPLEMENTATIONS_DEFINITION,
];
