import { readFileSync } from "node:fs";
import { cpus, freemem, totalmem } from "node:os";
import { sendAlert } from "../bot/alerts.ts";

export interface SystemLoadLimits {
	cpuPercent: number;
	memoryPercent: number;
	eventLoopLagMs: number;
}

export type ExceededResource = "cpu" | "memory" | "eventLoop";

export interface SystemLoadSnapshot {
	cpuPercent: number;
	memoryPercent: number;
	eventLoopLagMs: number;
	/** Percentage of the configured limit consumed; 100 means at the limit. */
	capacityPercent: number;
	exceeded: boolean;
	exceededResources: ExceededResource[];
	limits: SystemLoadLimits;
	sampledAt: number;
}

interface CpuTimes {
	idle: number;
	total: number;
}

export interface LoadAlertState {
	active: boolean;
	overStreak: number;
	recoveryStreak: number;
}

export type LoadAlertEvent = "overload" | "recovered";

function envNumber(name: string, fallback: number, min: number, max: number): number {
	const value = Number(process.env[name] ?? fallback);
	return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

export const systemLoadLimits: SystemLoadLimits = {
	cpuPercent: envNumber("SYSTEM_CPU_LIMIT_PERCENT", 80, 1, 100),
	memoryPercent: envNumber("SYSTEM_MEMORY_LIMIT_PERCENT", 80, 1, 100),
	eventLoopLagMs: envNumber("SYSTEM_EVENT_LOOP_LIMIT_MS", 100, 1, 60_000),
};

const MONITOR_INTERVAL_MS = envNumber("SYSTEM_MONITOR_INTERVAL_MS", 5_000, 1_000, 60_000);
const OVERLOAD_SAMPLES = envNumber("SYSTEM_ALERT_SUSTAINED_SAMPLES", 3, 1, 60);
const RECOVERY_SAMPLES = envNumber("SYSTEM_ALERT_RECOVERY_SAMPLES", 3, 1, 60);

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

function readCpuTimes(): CpuTimes {
	let idle = 0;
	let total = 0;
	for (const cpu of cpus()) {
		idle += cpu.times.idle;
		total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
	}
	return { idle, total };
}

export function calculateCpuPercent(previous: CpuTimes, current: CpuTimes): number {
	const totalDelta = current.total - previous.total;
	const idleDelta = current.idle - previous.idle;
	if (totalDelta <= 0) return 0;
	return clampPercent((1 - idleDelta / totalDelta) * 100);
}

function readMemoryPercent(): number {
	// Linux's MemAvailable excludes reclaimable cache from "used" memory.
	// os.freemem() does not, which would make an idle host look nearly full.
	if (process.platform === "linux") {
		try {
			const info = readFileSync("/proc/meminfo", "utf8");
			const totalKb = Number(info.match(/^MemTotal:\s+(\d+)/m)?.[1]);
			const availableKb = Number(info.match(/^MemAvailable:\s+(\d+)/m)?.[1]);
			if (totalKb > 0 && availableKb >= 0) return clampPercent((1 - availableKb / totalKb) * 100);
		} catch {
			// Fall through to the portable estimate.
		}
	}
	const total = totalmem();
	return total > 0 ? clampPercent((1 - freemem() / total) * 100) : 0;
}

export function buildSystemLoadSnapshot(
	cpuPercent: number,
	memoryPercent: number,
	eventLoopLagMs: number,
	limits: SystemLoadLimits = systemLoadLimits,
	sampledAt = Date.now(),
): SystemLoadSnapshot {
	const exceededResources: ExceededResource[] = [];
	if (cpuPercent >= limits.cpuPercent) exceededResources.push("cpu");
	if (memoryPercent >= limits.memoryPercent) exceededResources.push("memory");
	if (eventLoopLagMs >= limits.eventLoopLagMs) exceededResources.push("eventLoop");
	const capacityPercent = Math.max(
		(cpuPercent / limits.cpuPercent) * 100,
		(memoryPercent / limits.memoryPercent) * 100,
		(eventLoopLagMs / limits.eventLoopLagMs) * 100,
	);
	return {
		cpuPercent,
		memoryPercent,
		eventLoopLagMs,
		capacityPercent,
		exceeded: exceededResources.length > 0,
		exceededResources,
		limits,
		sampledAt,
	};
}

/** Pure sustained-overload/recovery policy used by the background monitor. */
export function advanceLoadAlertState(
	state: LoadAlertState,
	exceeded: boolean,
	overloadSamples = OVERLOAD_SAMPLES,
	recoverySamples = RECOVERY_SAMPLES,
): { state: LoadAlertState; event?: LoadAlertEvent } {
	if (exceeded) {
		const overStreak = state.overStreak + 1;
		const active = state.active || overStreak >= overloadSamples;
		return {
			state: { active, overStreak, recoveryStreak: 0 },
			// While active, repeat the event; alerts.ts applies its 10-minute
			// cooldown so a continuing overload still sends periodic reminders.
			event: active ? "overload" : undefined,
		};
	}

	if (!state.active) return { state: { active: false, overStreak: 0, recoveryStreak: 0 } };
	const recoveryStreak = state.recoveryStreak + 1;
	if (recoveryStreak < recoverySamples) {
		return { state: { active: true, overStreak: 0, recoveryStreak } };
	}
	return {
		state: { active: false, overStreak: 0, recoveryStreak: 0 },
		event: "recovered",
	};
}

let latestSnapshot = buildSystemLoadSnapshot(0, readMemoryPercent(), 0);
let started = false;

export function getSystemLoadSnapshot(): SystemLoadSnapshot {
	return latestSnapshot;
}

function alertDetail(snapshot: SystemLoadSnapshot): string {
	return [
		`โหลดเทียบขีดจำกัด ${snapshot.capacityPercent.toFixed(0)}%`,
		`CPU ${snapshot.cpuPercent.toFixed(1)}% / ${snapshot.limits.cpuPercent}%`,
		`RAM ${snapshot.memoryPercent.toFixed(1)}% / ${snapshot.limits.memoryPercent}%`,
		`Event loop ${snapshot.eventLoopLagMs.toFixed(1)}ms / ${snapshot.limits.eventLoopLagMs}ms`,
	].join("\n");
}

export function startSystemLoadMonitor(): void {
	if (started || process.env.NODE_ENV === "test") return;
	started = true;
	let previousCpu = readCpuTimes();
	let expectedAt = performance.now() + MONITOR_INTERVAL_MS;
	let alertState: LoadAlertState = { active: false, overStreak: 0, recoveryStreak: 0 };

	const timer = setInterval(() => {
		const now = performance.now();
		const lagMs = Math.max(0, now - expectedAt);
		expectedAt = now + MONITOR_INTERVAL_MS;
		const currentCpu = readCpuTimes();
		const cpuPercent = calculateCpuPercent(previousCpu, currentCpu);
		previousCpu = currentCpu;
		latestSnapshot = buildSystemLoadSnapshot(cpuPercent, readMemoryPercent(), lagMs);

		const transition = advanceLoadAlertState(alertState, latestSnapshot.exceeded);
		alertState = transition.state;
		if (transition.event === "overload") {
			sendAlert("system_overload", 0, "ระบบบอท", alertDetail(latestSnapshot));
		} else if (transition.event === "recovered") {
			sendAlert("system_recovered", 0, "ระบบบอท", alertDetail(latestSnapshot));
		}
	}, MONITOR_INTERVAL_MS);
	timer.unref?.();

	console.log(
		`[system-load] monitoring every ${MONITOR_INTERVAL_MS}ms; limits CPU=${systemLoadLimits.cpuPercent}% ` +
			`RAM=${systemLoadLimits.memoryPercent}% event-loop=${systemLoadLimits.eventLoopLagMs}ms`,
	);
}
