// Internal (Nexus #297): process-level reaction to a lost storage writer lease. Not a public API.
// Process entry points (CLI stdio/HTTP/managed/reindex, `nexus serve`) register a fail-fast handler that terminates
// the process, so a runtime whose lease is gone can neither keep mutating storage nor linger as a zombie owner.

export type WriterLeaseLostHandler = (error: Error) => void;

let processHandler: WriterLeaseLostHandler | undefined;

/** Register (or clear with `undefined`) the process-wide lease-loss handler. Returns the previous handler. */
export function setWriterLeaseLostHandler(handler: WriterLeaseLostHandler | undefined): WriterLeaseLostHandler | undefined {
  const previous = processHandler;
  processHandler = handler;
  return previous;
}

export function getWriterLeaseLostHandler(): WriterLeaseLostHandler | undefined {
  return processHandler;
}
