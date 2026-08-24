import type { MonitoredServerId } from "./types.ts";

/**
 * Fixed categorical identity per server — order and hues never change
 * (validated for CVD-safety, all-pairs, against this app's dark surface;
 * see dataviz skill). Used everywhere a chart or card needs to say
 * "this line/dot is server N", consistently across the Servers tab.
 */
export const MONITORED_SERVERS: ReadonlyArray<{ id: MonitoredServerId; label: string; role: string; color: string }> = [
	{ id: "server1", label: "Server 1", role: "AWS gateway", color: "#3987e5" },
	{ id: "server2", label: "Server 2", role: "Bot worker", color: "#d95926" },
	{ id: "server3", label: "Server 3", role: "Lane relay", color: "#199e70" },
];

export const SERVER_COLOR: Record<MonitoredServerId, string> = Object.fromEntries(MONITORED_SERVERS.map((s) => [s.id, s.color])) as Record<
	MonitoredServerId,
	string
>;

export const SERVER_LABEL: Record<MonitoredServerId, string> = Object.fromEntries(MONITORED_SERVERS.map((s) => [s.id, s.label])) as Record<
	MonitoredServerId,
	string
>;
