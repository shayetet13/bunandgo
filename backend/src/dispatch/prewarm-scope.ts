import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Marks the call tree of a warm-up run, so the transport can answer it from
 * RAM without any request reaching LINE.
 *
 * This is deliberately an async-context scope and not a flag on the client.
 * A flag is on for a span of *time*: any real request that happened to be in
 * flight while a warm-up ran was answered with the canned ACK too — the
 * poller's `fetchSquareChatEvents` received a `sendMessage` ACK, and a real
 * automatic reply was reported as sent without ever leaving the process.
 * A scope is on for a span of *call stack*, so concurrent real traffic on the
 * same client is untouched by construction.
 *
 * The measured cost of the lookup on the ordinary send path — outside any
 * scope — is ~2ns per call. The context-propagation cost that AsyncLocalStorage
 * adds to an await chain is paid only inside `runInPrewarmScope`, which is
 * warm-up work and not latency-sensitive.
 */
export interface PrewarmScope {
	/**
	 * Sequence numbers handed out during the warm-up. Kept here rather than on
	 * the client so a dry run never consumes a real LINE reqseq, and so two
	 * concurrent warm-ups cannot advance each other's counters.
	 */
	reqseqs: Record<string, number>;
}

const storage = new AsyncLocalStorage<PrewarmScope>();

/** The warm-up this call belongs to, or undefined for ordinary traffic. */
export function currentPrewarmScope(): PrewarmScope | undefined {
	return storage.getStore();
}

/** Runs `fn` as a warm-up. Nested calls join the enclosing scope. */
export function runInPrewarmScope<T>(fn: () => Promise<T>): Promise<T> {
	if (storage.getStore()) return fn();
	return storage.run({ reqseqs: {} }, fn);
}
