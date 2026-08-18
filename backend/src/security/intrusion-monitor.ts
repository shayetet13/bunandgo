import { getConnInfo } from "hono/bun";
import type { Context, Next } from "hono";
import { logUnauthenticatedUserAction } from "../auth/user-actions.ts";
import { sendAlert } from "../bot/alerts.ts";
import { isTrustedWorkerForward } from "../api/worker-proxy.ts";
import { securityEvents, type SecurityAlertEvent } from "./security-events.ts";
import { formatGeoLine, lookupIpGeo } from "./ip-geo.ts";

export type SecurityIncidentKind =
	| "login_failed"
	| "login_throttled"
	| "invalid_session"
	| "forbidden_access"
	| "cross_site_write"
	| "untrusted_websocket"
	| "invalid_worker_token"
	| "shard_bypass"
	| "scanner_probe"
	| "data_scrape"
	| "oversized_request"
	| "suspicious_method";

export type SecuritySeverity = "medium" | "high" | "critical";

interface SecurityIncident {
	kind: SecurityIncidentKind;
	severity: SecuritySeverity;
	username?: string;
	detail?: string;
	path?: string;
}

interface IncidentBucket {
	windowStartedAt: number;
	count: number;
	lastAlertAt?: number;
}

const INCIDENT_WINDOW_MS = 10 * 60_000;
const MAX_TRACKED_INCIDENTS = 10_000;
const GLOBAL_ALERT_WINDOW_MS = 5 * 60_000;
const MAX_ALERTS_PER_WINDOW = 12;
const API_RATE_WINDOW_MS = 60_000;
const API_RATE_LIMIT = 300;
const SENSITIVE_READ_RATE_LIMIT = 60;
const MAX_RATE_KEYS = 10_000;

const incidentBuckets = new Map<string, IncidentBucket>();
const requestRates = new Map<string, { startedAt: number; count: number }>();
const sentAlertTimes: number[] = [];
const liveEventTimes: number[] = [];
let lastOverflowAlertAt = 0;

const SUSPICIOUS_METHODS = new Set(["CONNECT", "TRACE", "TRACK", "PROPFIND", "COPY", "MOVE"]);
const SENSITIVE_READ_PATHS = [
	"/api/logs",
	"/api/metrics/history",
	"/api/metrics/lane-race",
	"/api/users",
	"/api/bots",
	"/api/confirm",
];

const SCANNER_PATH = /(?:^|\/)(?:\.env|\.git|\.svn|\.hg|wp-admin|wp-login\.php|phpmyadmin|adminer(?:\.php)?|server-status|actuator|vendor\/phpunit|cgi-bin|etc\/passwd)(?:\/|$)|(?:\.sql|\.sqlite3?|\.db|\.bak|\.pem|\.key|\.log|\.map)$|(?:\.\.|%2e%2e|%252e)/i;

const INCIDENT_LABELS: Record<SecurityIncidentKind, string> = {
	login_failed: "เดารหัสผ่าน/ล็อกอินไม่สำเร็จซ้ำ",
	login_throttled: "ยิงหน้าเข้าสู่ระบบเกินกำหนด",
	invalid_session: "เรียก API ด้วย session ที่ใช้ไม่ได้",
	forbidden_access: "บัญชีไม่มีสิทธิ์พยายามเข้าถึงข้อมูล",
	cross_site_write: "เว็บภายนอกพยายามส่งคำสั่งเข้าระบบ",
	untrusted_websocket: "เว็บภายนอกพยายามเปิด WebSocket",
	invalid_worker_token: "เรียกช่องทางภายในด้วย control token ไม่ถูกต้อง",
	shard_bypass: "พยายามข้าม control plane เข้า shard",
	scanner_probe: "สแกนหาไฟล์ลับหรือช่องโหว่เว็บ",
	data_scrape: "เรียกอ่านข้อมูลถี่ผิดปกติ",
	oversized_request: "ส่ง request ใหญ่เกินกำหนด",
	suspicious_method: "ใช้ HTTP method ผิดปกติ",
};

const ALERT_AFTER: Record<SecurityIncidentKind, number> = {
	login_failed: 3,
	invalid_session: 5,
	login_throttled: 1,
	forbidden_access: 1,
	cross_site_write: 1,
	untrusted_websocket: 1,
	invalid_worker_token: 1,
	shard_bypass: 1,
	scanner_probe: 1,
	data_scrape: 1,
	oversized_request: 1,
	suspicious_method: 1,
};

function safeText(value: string | undefined, maxLength: number, fallback = "-"): string {
	const clean = [...(value ?? "")]
		.filter((character) => {
			const code = character.charCodeAt(0);
			return code >= 0x20 && code !== 0x7f;
		})
		.join("")
		.trim()
		.slice(0, maxLength);
	return clean || fallback;
}

export function requestIp(c: Context): string {
	// Production accepts public traffic only through our Nginx gateway, which
	// overwrites X-Real-IP. Never trust X-Forwarded-For's attacker-appended list.
	const forwarded = c.req.header("x-real-ip")?.trim();
	if (forwarded && forwarded.length <= 64 && /^[0-9a-f:.]+$/i.test(forwarded)) return forwarded;
	try {
		return getConnInfo(c).remote.address ?? "unknown";
	} catch {
		return "unknown";
	}
}

export function isScannerPath(path: string): boolean {
	return SCANNER_PATH.test(path);
}

function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
	map.delete(key);
	if (map.size >= max) {
		const oldest = map.keys().next().value;
		if (oldest !== undefined) map.delete(oldest);
	}
	map.set(key, value);
}

function takeIncident(key: string, kind: SecurityIncidentKind, now: number): { count: number; alert: boolean; first: boolean } {
	const previous = incidentBuckets.get(key);
	const fresh = !previous || now - previous.windowStartedAt >= INCIDENT_WINDOW_MS;
	const bucket: IncidentBucket = fresh
		? { windowStartedAt: now, count: 1 }
		: { ...previous, count: previous.count + 1 };
	const thresholdReached = bucket.count >= ALERT_AFTER[kind];
	const alert = thresholdReached && (bucket.lastAlertAt === undefined || now - bucket.lastAlertAt >= INCIDENT_WINDOW_MS);
	if (alert) bucket.lastAlertAt = now;
	boundedSet(incidentBuckets, key, bucket, MAX_TRACKED_INCIDENTS);
	return { count: bucket.count, alert, first: fresh };
}

function canSendSecurityAlert(now: number): boolean {
	while (sentAlertTimes.length > 0 && now - sentAlertTimes[0]! >= GLOBAL_ALERT_WINDOW_MS) sentAlertTimes.shift();
	if (sentAlertTimes.length < MAX_ALERTS_PER_WINDOW) {
		sentAlertTimes.push(now);
		return true;
	}
	if (now - lastOverflowAlertAt >= GLOBAL_ALERT_WINDOW_MS) {
		lastOverflowAlertAt = now;
		sendAlert(
			"security_intrusion",
			0,
			"security",
			`ระดับ: สูง\nเหตุการณ์: มีเหตุการณ์เพิ่มเติมจำนวนมาก ระบบรวมการแจ้งเตือนเพื่อป้องกัน Telegram ถูก spam\nช่วงเวลา: 5 นาทีล่าสุด`,
			"security:alert-overflow",
		);
	}
	return false;
}

function canEmitLiveSecurityEvent(now: number): boolean {
	while (liveEventTimes.length > 0 && now - liveEventTimes[0]! >= GLOBAL_ALERT_WINDOW_MS) liveEventTimes.shift();
	if (liveEventTimes.length >= MAX_ALERTS_PER_WINDOW * 2) return false;
	liveEventTimes.push(now);
	return true;
}

/**
 * Records and alerts without awaiting network or SQLite. This function is
 * safe to call from request guards and never enters the LINE reply hot path.
 */
export function reportSecurityIncident(c: Context, incident: SecurityIncident): void {
	const now = Date.now();
	const ip = requestIp(c);
	const method = safeText(c.req.method.toUpperCase(), 16);
	const path = safeText(incident.path ?? new URL(c.req.url).pathname, 256);
	const username = safeText(incident.username, 100, "(anonymous)");
	// Group path-rotating scanners by IP+kind. The current path is still in the
	// audit row/message, but cannot be used to bypass dedupe.
	const key = `${incident.kind}|${ip}|${username}`;
	const decision = takeIncident(key, incident.kind, now);
	const detail = {
		severity: incident.severity,
		ip,
		method,
		path,
		count: decision.count,
		userAgent: safeText(c.req.header("user-agent"), 180),
		detail: safeText(incident.detail, 180),
	};
	// Persist the first sighting and each alert point only. A flood remains
	// measurable without allowing the attacker to turn audit logging into a
	// write-amplification attack against SQLite.
	if (decision.first || decision.alert) {
		logUnauthenticatedUserAction(username, `security.${incident.kind}`, detail);
	}
	// Only the first sighting and alert thresholds reach the live dashboard;
	// this keeps a scanner from turning an open admin tab into a notification
	// flood while still surfacing a new probe immediately.
	if ((decision.first || decision.alert) && canEmitLiveSecurityEvent(now)) {
		const event: SecurityAlertEvent = {
			kind: incident.kind,
			severity: incident.severity,
			ts: now,
			ip,
			method,
			path,
			count: decision.count,
			userAgent: detail.userAgent,
			detail: detail.detail,
		};
		securityEvents.emit("security_alert", event);
	}
	if (!decision.alert || !canSendSecurityAlert(now)) return;
	const severity = incident.severity === "critical" ? "วิกฤต" : incident.severity === "high" ? "สูง" : "ปานกลาง";
	const lines = [
		`ระดับ: ${severity}`,
		`เหตุการณ์: ${INCIDENT_LABELS[incident.kind]}`,
		`IP: ${ip}`,
		`Request: ${method} ${path}`,
		`จำนวน: ${decision.count} ครั้งในช่วง 10 นาที`,
		`User-Agent: ${detail.userAgent}`,
	];
	// A geo lookup is a network call; the alert must still go out immediately
	// if it stalls or fails; this function's contract (see the docstring
	// above) is to never make the caller wait on the network.
	void (async () => {
		const geo = await lookupIpGeo(ip);
		sendAlert("security_intrusion", 0, "security", [...lines, formatGeoLine(geo)].join("\n"), `security:${key}`);
	})();
}

function takeRate(key: string, now: number): number {
	const previous = requestRates.get(key);
	const next = !previous || now - previous.startedAt >= API_RATE_WINDOW_MS
		? { startedAt: now, count: 1 }
		: { startedAt: previous.startedAt, count: previous.count + 1 };
	boundedSet(requestRates, key, next, MAX_RATE_KEYS);
	return next.count;
}

/** Public HTTP perimeter: scanner/method/body and bulk-read rate controls. */
export async function monitorPublicRequest(c: Context, next: Next) {
	const path = new URL(c.req.url).pathname;
	if (path === "/internal/security-probe") return await next();
	if (isTrustedWorkerForward(c) || path === "/internal/worker-events") return await next();

	const method = c.req.method.toUpperCase();
	if (SUSPICIOUS_METHODS.has(method)) {
		reportSecurityIncident(c, { kind: "suspicious_method", severity: "high" });
		return c.json({ error: "method not allowed" }, 405);
	}
	if (isScannerPath(path)) {
		reportSecurityIncident(c, { kind: "scanner_probe", severity: "high" });
		return c.json({ error: "not found" }, 404);
	}

	const contentLength = Number(c.req.header("content-length"));
	if (Number.isFinite(contentLength) && contentLength > 64 * 1024) {
		reportSecurityIncident(c, { kind: "oversized_request", severity: "high" });
		return c.json({ error: "request too large" }, 413);
	}

	const ip = requestIp(c);
	if (path.startsWith("/api/") && ip !== "unknown") {
		const total = takeRate(`api|${ip}`, Date.now());
		if (total > API_RATE_LIMIT) {
			reportSecurityIncident(c, { kind: "data_scrape", severity: "high", detail: "API request rate exceeded" });
			c.header("Retry-After", "60");
			return c.json({ error: "too many requests" }, 429);
		}
		if (method === "GET" && SENSITIVE_READ_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
			const sensitive = takeRate(`read|${ip}`, Date.now());
			if (sensitive > SENSITIVE_READ_RATE_LIMIT) {
				reportSecurityIncident(c, { kind: "data_scrape", severity: "critical", detail: "Sensitive read rate exceeded" });
				c.header("Retry-After", "60");
				return c.json({ error: "too many data requests" }, 429);
			}
		}
	}

	await next();
}
