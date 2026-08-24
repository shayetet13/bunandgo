import { cpus, loadavg } from "node:os";
import { readFileSync } from "node:fs";
import { laneRaceView, laneStats } from "../dispatch/h2-lanes.ts";
import { relayConfig } from "./config.ts";

let timer: ReturnType<typeof setInterval> | undefined;
let lastFailureLogAt = 0;
let reportInFlight = false;

const LOAD_LIMIT_PERCENT = Number(process.env.SYSTEM_HOST_LOAD_LIMIT_PERCENT ?? 80);

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

function memoryPercent(): number {
	try {
		const info = readFileSync("/proc/meminfo", "utf8");
		const totalKb = Number(info.match(/^MemTotal:\s+(\d+)/m)?.[1]);
		const availableKb = Number(info.match(/^MemAvailable:\s+(\d+)/m)?.[1]);
		if (totalKb > 0 && availableKb >= 0) return clampPercent((1 - availableKb / totalKb) * 100);
	} catch {
		// Linux memory metrics are optional; report no load only if unavailable.
	}
	return 0;
}

/** Same shape as server1-status-agent.ts's currentLoad() — a separate box, a
 * small acceptable duplication rather than a shared package for two deployables. */
function currentLoad() {
	const cpuPercent = clampPercent((loadavg()[0] / Math.max(1, cpus().length)) * 100);
	const memPercent = memoryPercent();
	const capacityPercent = Math.max((cpuPercent / LOAD_LIMIT_PERCENT) * 100, (memPercent / LOAD_LIMIT_PERCENT) * 100);
	return {
		cpuPercent,
		memoryPercent: memPercent,
		capacityPercent,
		exceeded: capacityPercent >= 100,
		sampledAt: Date.now(),
	};
}

async function pushReport(): Promise<void> {
	if (reportInFlight) return;
	reportInFlight = true;
	try {
		const body = JSON.stringify({
			workerId: relayConfig.workerId,
			ts: Date.now(),
			lanes: laneStats(),
			races: laneRaceView(),
			load: currentLoad(),
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
