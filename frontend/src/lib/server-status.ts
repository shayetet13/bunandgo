import type { ServerStatus } from "./types.ts";

export type ServerTone = "go" | "warn" | "bad" | "idle";

export interface ServerSummary {
	label: string;
	detail: string;
	tone: ServerTone;
}

export function summarizeServer(server?: ServerStatus): ServerSummary {
	if (!server) return { label: "กำลังตรวจ...", detail: "ยังไม่ได้รับสถานะของเครื่อง", tone: "idle" };
	if (!server.reachable) return { label: "ติดต่อไม่ได้", detail: server.detail ?? "ไม่สามารถเชื่อมต่อเครื่องนี้ผ่านเครือข่ายส่วนตัว", tone: "bad" };
	if (!server.serviceHealthy) return { label: "บริการมีปัญหา", detail: server.detail ?? "บริการหลักของเครื่องนี้ไม่ตอบสนอง", tone: "bad" };
	if (!server.load) return { label: "กำลังวัดโหลด...", detail: "เครื่องตอบสนอง แต่ยังไม่มีตัวเลขโหลด", tone: "idle" };

	const capacity = Math.max(0, Math.round(server.load.capacityPercent));
	if (server.load.exceeded) return { label: `โหลด ${capacity}%`, detail: `โหลดเกินขีดจำกัด · CPU ${server.load.cpuPercent.toFixed(1)}% · RAM ${server.load.memoryPercent.toFixed(1)}%`, tone: "bad" };
	if (capacity >= 80) return { label: `โหลด ${capacity}%`, detail: `โหลดใกล้ขีดจำกัด · CPU ${server.load.cpuPercent.toFixed(1)}% · RAM ${server.load.memoryPercent.toFixed(1)}%`, tone: "warn" };
	return { label: `โหลด ${capacity}%`, detail: `ปกติ · CPU ${server.load.cpuPercent.toFixed(1)}% · RAM ${server.load.memoryPercent.toFixed(1)}%`, tone: "go" };
}
