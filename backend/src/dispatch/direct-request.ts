const HOT_LINE_FETCH = Symbol.for("linebot.hotLineFetch");
const HOT_LINE_PREWARM_FETCH = Symbol.for("linebot.hotLinePrewarmFetch");

export type HotLineFetch = (
	info: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

type FetchWithHotPath = {
	[HOT_LINE_FETCH]?: HotLineFetch;
	[HOT_LINE_PREWARM_FETCH]?: HotLineFetch;
};

export function attachHotLineFetch<T extends object>(
	fetchLike: T,
	hotFetch: HotLineFetch,
	prewarmFetch?: HotLineFetch,
): T {
	Object.defineProperty(fetchLike, HOT_LINE_FETCH, { value: hotFetch });
	if (prewarmFetch) {
		Object.defineProperty(fetchLike, HOT_LINE_PREWARM_FETCH, { value: prewarmFetch });
	}
	return fetchLike;
}

export function getHotLineFetch(fetchLike: unknown): HotLineFetch | undefined {
	return (fetchLike as FetchWithHotPath | undefined)?.[HOT_LINE_FETCH];
}

export function getHotLinePrewarmFetch(fetchLike: unknown): HotLineFetch | undefined {
	return (fetchLike as FetchWithHotPath | undefined)?.[HOT_LINE_PREWARM_FETCH];
}
