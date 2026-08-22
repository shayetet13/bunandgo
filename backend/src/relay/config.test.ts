import { describe, expect, test } from "bun:test";

process.env.LANE_RELAY_DISPATCH_TOKEN ??= "test-dispatch-token";
process.env.LANE_RELAY_REPORT_URL ??= "http://127.0.0.1:8791/internal/lane-relay-events";
process.env.LANE_RELAY_REPORT_TOKEN ??= "test-report-token";
delete process.env.LANE_RELAY_LINE_ORIGINS;
delete process.env.LANE_RELAY_ALLOWED_ORIGINS;

const { relayConfig } = await import("./config.ts");

describe("lane relay isolation", () => {
	test("accepts only the configured lane origin by default", () => {
		expect(relayConfig.lineOrigins).toEqual(["https://legy.line-apps.com"]);
		expect(relayConfig.allowedOrigins).toEqual(relayConfig.lineOrigins);
		expect(relayConfig.allowedOrigins).not.toContain("https://gf.line.naver.jp");
	});
});
