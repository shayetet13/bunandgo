import { timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { readWorkerTopology } from "../bot/worker-topology.ts";

export const CONTROL_TOKEN_HEADER = "x-linebot-control-token";
export const FORWARDED_HEADER = "x-linebot-worker-forwarded";

function safeTokenEqual(left: string | undefined, right: string | undefined): boolean {
	if (!left || !right) return false;
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
}

export function hasValidControlToken(c: Context): boolean {
	return safeTokenEqual(c.req.header(CONTROL_TOKEN_HEADER), readWorkerTopology().controlPlaneToken);
}

export function isTrustedWorkerForward(c: Context): boolean {
	return c.req.header(FORWARDED_HEADER) === "1" && hasValidControlToken(c);
}
