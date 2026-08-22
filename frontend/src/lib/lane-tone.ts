export function rttToneClass(applicationMeasurement: boolean, routingPreferred: boolean): string {
	// PING alone proves only that the socket is alive. A lane becomes green
	// only when its real send/poll result is currently the fastest. Slower
	// measured lanes remain neutral standbys; red is reserved for failures.
	if (!applicationMeasurement) return "chip--idle";
	return routingPreferred ? "chip--go" : "chip--idle";
}
