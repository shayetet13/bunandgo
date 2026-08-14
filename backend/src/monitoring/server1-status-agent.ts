import { cpus, loadavg, uptime } from "node:os";
import { readFileSync } from "node:fs";
import { connect } from "node:net";

const PORT = Number(process.env.SERVER1_STATUS_PORT ?? 8792);
const HOST = process.env.SERVER1_STATUS_HOST ?? "10.77.0.1";
const LIMIT_PERCENT = Number(process.env.SYSTEM_HOST_LOAD_LIMIT_PERCENT ?? 80);

function clamp(value: number): number {
	return Math.max(0, Math.min(100, value));
}

function memoryPercent(): number {
	try {
		const info = readFileSync("/proc/meminfo", "utf8");
		const totalKb = Number(info.match(/^MemTotal:\s+(\d+)/m)?.[1]);
		const availableKb = Number(info.match(/^MemAvailable:\s+(\d+)/m)?.[1]);
		if (totalKb > 0 && availableKb >= 0) return clamp((1 - availableKb / totalKb) * 100);
	} catch {
		// Linux memory metrics are optional; report no load only if unavailable.
	}
	return 0;
}

function gatewayHealthy(): Promise<boolean> {
	// The gateway is TLS-only, so a TCP connection is the accurate local
	// liveness check and avoids treating a valid certificate hostname as a failure.
	return new Promise((resolve) => {
		let settled = false;
		const finish = (healthy: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve(healthy);
		};
		const socket = connect({ host: "127.0.0.1", port: 443 });
		const timeout = setTimeout(() => {
			socket.destroy();
			finish(false);
		}, 1_000);
		socket.once("connect", () => {
			socket.end();
			finish(true);
		});
		socket.once("error", () => finish(false));
	});
}

function currentLoad() {
	const cpuPercent = clamp((loadavg()[0] / Math.max(1, cpus().length)) * 100);
	const ramPercent = memoryPercent();
	const capacityPercent = Math.max((cpuPercent / LIMIT_PERCENT) * 100, (ramPercent / LIMIT_PERCENT) * 100);
	return {
		cpuPercent,
		memoryPercent: ramPercent,
		capacityPercent,
		exceeded: capacityPercent >= 100,
		sampledAt: Date.now(),
	};
}

Bun.serve({
	hostname: HOST,
	port: PORT,
	async fetch(request) {
		if (new URL(request.url).pathname !== "/healthz") return new Response("Not found", { status: 404 });
		const healthy = await gatewayHealthy();
		return Response.json({
			id: "server1",
			serviceHealthy: healthy,
			load: currentLoad(),
			detail: healthy ? `AWS gateway ปกติ · uptime ${Math.floor(uptime() / 60)} นาที` : "Nginx gateway ไม่ตอบสนอง",
		});
	},
});

console.log(`[server1-status-agent] listening on http://${HOST}:${PORT}/healthz`);
