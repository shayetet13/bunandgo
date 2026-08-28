import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// scripts/pin-legy-fast-ips.sh writes /opt/linebot/shared/legy-ip-rank.json and
// orders the pinned /etc/hosts block fastest-median-first. The full script needs
// curl + root + DNS, so __fixtures__/ip-rank-snippet.sh carries the two pieces
// h2-lanes.ts depends on verbatim; this locks their output shape.
const result = Bun.spawnSync(["bash", join(import.meta.dir, "__fixtures__", "ip-rank-snippet.sh")]);
const stdout = result.stdout.toString();
const order = stdout.match(/^ORDER (.+)$/m)?.[1] ?? "";
const json = stdout.match(/^JSON (.+)$/m)?.[1] ?? "";

describe("pin-legy-fast-ips.sh ranking output", () => {
	test("orders the fast set by ascending median", () => {
		expect(result.exitCode).toBe(0);
		expect(order).toBe("147.92.146.129 147.92.146.138 147.92.185.1");
	});

	test("emits a flat {ip: medianMs} object h2-lanes.ts can parse", () => {
		const parsed = JSON.parse(json) as Record<string, number>;
		expect(parsed).toEqual({
			"147.92.185.1": 14.2,
			"147.92.146.129": 9.8,
			"2400:dcc0::9": 31,
			"147.92.146.138": 12.5,
		});
		for (const value of Object.values(parsed)) expect(typeof value).toBe("number");
	});
});
