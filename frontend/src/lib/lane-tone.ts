export function rttToneClass(applicationMeasurement: boolean, routingEligible: boolean): string {
	// PING alone proves only that the socket is alive. A lane becomes green
	// after a real send/poll measurement confirms that application routing is
	// below the active ceiling.
	if (!applicationMeasurement) return "chip--idle";
	return routingEligible ? "chip--go" : "chip--bad";
}
