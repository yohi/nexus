/**
 * Placeholder for the indexer event queue.
 * Purpose: queuing incoming events, ordering guarantees, retry/backoff, acknowledgment semantics, lifecycle/start/stop.
 * API surface to implement: EventQueue class, methods like enqueueEvent(event), processNextEvent(), start(), stop().
 * Integration: works with the indexer worker/processEvent.
 */
export {};
