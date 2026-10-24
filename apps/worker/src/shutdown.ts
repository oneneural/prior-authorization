// Worker shutdown bounds (docs/operations.md#shutdown). This module has no
// startup side effects, so the shutdown budget tests can import it.

/** Claimed jobs get this long to finish after SIGTERM. */
export const DRAIN_DEADLINE_MS = 27_000;

/**
 * Safety net if returning jobs or closing the pools hangs after the drain. At
 * least 5 s after the drain deadline, so failing jobs back to the queue is not
 * cut short, and below the worker's 35-second s6 timeout-down.
 */
export const EXIT_DEADLINE_MS = DRAIN_DEADLINE_MS + 6_000;
