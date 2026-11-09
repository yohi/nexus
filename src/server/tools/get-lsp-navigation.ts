import type { LspNavigationKind, NavigationResponse, NavigationToolArgs } from '../../lsp/contracts.js';
import type { LspNavigationService } from '../../lsp/navigation-service.js';
import { validateNavigationTargetArgs } from '../../lsp/target-resolver.js';

const NOT_CONFIGURED: NavigationResponse = Object.freeze({
  status: 'unavailable',
  capability: 'unavailable',
  locations: [],
  truncated: false,
  sourceValidation: 'unknown',
  reasonCode: 'LSP_NOT_CONFIGURED',
}) as NavigationResponse;

/**
 * Common executor for get_definition / get_references / get_implementations. Malformed target
 * shapes throw InvalidNavigationArgumentsError (surfaced through ordinary tool error handling)
 * before any service call; a missing runtime navigation service is an LSP-local
 * `unavailable` / `LSP_NOT_CONFIGURED` outcome that never affects other tools.
 */
export const executeLspNavigation = async (
  service: LspNavigationService | undefined,
  kind: LspNavigationKind,
  args: NavigationToolArgs,
  signal?: AbortSignal,
): Promise<NavigationResponse> => {
  validateNavigationTargetArgs(args);
  if (service === undefined) return { ...NOT_CONFIGURED, locations: [] };
  return service.navigate({ kind, args, ...(signal === undefined ? {} : { signal }) });
};
