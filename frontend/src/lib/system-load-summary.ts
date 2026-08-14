import type { SystemLoadStatus } from "./types.ts";

export type SystemLoadTone = "go" | "warn" | "bad" | "idle";

export interface SystemLoadSummary {
	label: string;
	detail: string;
	tone: SystemLoadTone;
}

export function summarizeSystemLoad(load?: SystemLoadStatus): SystemLoadSummary {
	if (!load) {
		return { label: "กำลังตรวจโหลด...", detail: "ยังไม่ได้รับข้อมูลโหลดจาก backend", tone: "idle" };
	}

	const capacity = Math.max(0, Math.round(load.capacityPercent));
	const status = load.exceeded ? "เกินขีดจำกัด" : capacity >= 80 ? "ใกล้ขีดจำกัด" : "ปกติ";
	return {
		label: `โหลดระบบ ${capacity}%`,
		detail: [
			`สถานะ: ${status}`,
			`CPU ${load.cpuPercent.toFixed(1)}% / ขีดจำกัด ${load.limits.cpuPercent}%`,
			`RAM ${load.memoryPercent.toFixed(1)}% / ขีดจำกัด ${load.limits.memoryPercent}%`,
			`Event loop ${load.eventLoopLagMs.toFixed(1)}ms / ขีดจำกัด ${load.limits.eventLoopLagMs}ms`,
		].join("\n"),
		tone: load.exceeded ? "bad" : capacity >= 80 ? "warn" : "go",
	};
}
