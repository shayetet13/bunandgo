/**
 * A request can fail because the network is momentarily unhealthy, or because
 * LINE has explicitly refused this account access to a particular OpenChat.
 * Only the latter is terminal for a per-room poller. Retrying it in a tight
 * loop cannot restore access and makes the useful diagnosis disappear in log
 * noise.
 */
const SQUARE_ACCESS_DENIED_MARKERS = ["AUTHENTICATION_FAILURE", "You don't have permission to access this section"];

function errorText(error: unknown): string {
	if (typeof error === "string") return error;
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

/** True only for LINE's explicit per-room authorization denial. */
export function isSquareAccessDenied(error: unknown): boolean {
	const text = errorText(error);
	return SQUARE_ACCESS_DENIED_MARKERS.some((marker) => text.includes(marker));
}
