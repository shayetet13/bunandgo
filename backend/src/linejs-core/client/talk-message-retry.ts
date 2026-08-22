import { isTransientTransportFailure } from "../base/login/transient.ts";

/** Fast retries first: a routine GOAWAY normally needs only one fresh RPC. */
export const TALK_MESSAGE_RETRY_DELAYS_MS = [0, 25, 75, 150, 300, 600] as const;

export function isRetryableTalkMessageError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return isTransientTransportFailure(message) || /The value of "offset" is out of range/i.test(message);
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Talk listener aborted");
}

function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError(signal));
			return;
		}
		const timer = setTimeout(done, ms);
		const onAbort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(abortError(signal!));
		};
		function done(): void {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Retries only the read-only work used to turn one received Talk operation
 * into a message. Keeping the operation in memory avoids advancing past it
 * and rebuilding the whole LINE session for a routine connection GOAWAY.
 */
export async function retryTalkMessageOperation<T>(
	operation: () => Promise<T>,
	options: {
		signal?: AbortSignal;
		delaysMs?: readonly number[];
	} = {},
): Promise<T> {
	const delays = options.delaysMs ?? TALK_MESSAGE_RETRY_DELAYS_MS;
	for (let attempt = 0; ; attempt++) {
		if (options.signal?.aborted) throw abortError(options.signal);
		try {
			return await operation();
		} catch (error) {
			if (!isRetryableTalkMessageError(error) || attempt >= delays.length) throw error;
			await waitForRetry(delays[attempt]!, options.signal);
		}
	}
}
