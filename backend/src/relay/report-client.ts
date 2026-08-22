import { laneRaceView, laneStats } from "../dispatch/h2-lanes.ts";
import { relayConfig } from "./config.ts";

let timer: ReturnType<typeof setInterval> | undefined;
let lastFailureLogAt = 0;
let reportInFlight = false;

async function pushReport(): Promise<void> {
	if (reportInFlight) return;
	reportInFlight = true;
	try {
		const body = JSON.stringify({
			workerId: relayConfig.workerId,
			ts: Date.now(),
			lanes: laneStats(),
			races: laneRaceView(),
		});
		const response = await fetch(relayConfig.reportUrl, {
			method: "POST",
			headers: { "content-type": "application/json", "x-lane-relay-token": relayConfig.reportToken },
			body,
			signal: AbortSignal.timeout(3_000),
		});
		if (!response.ok) throw new Error(`control plane responded ${response.status}`);
	} catch (error) {
		// This is a snapshot push, not a queued event — there is nothing
		// meaningful to retry with, the next tick just tries again with
		// fresher numbers. Rate-limit the log so a prolonged tunnel outage
		// doesn't spam once per report interval.
		const now = Date.now();
		if (now - lastFailureLogAt >= 30_000) {
			lastFailureLogAt = now;
			console.error("lane relay: report to control plane failed:", error instanceof Error ? error.message : error);
		}
	} finally {
		reportInFlight = false;
	}
}

export function startLaneRelayReporting(): void {
	if (timer) return;
	void pushReport();
	timer = setInterval(() => void pushReport(), relayConfig.reportIntervalMs);
	timer.unref?.();
}

/** Test/shutdown only. */
export function stopLaneRelayReporting(): void {
	if (timer) clearInterval(timer);
	timer = undefined;
	reportInFlight = false;
}
