import { describe, expect, test } from "bun:test";
import { parseRemoteLaneConfig, selectDistributedRoute } from "./remote-lanes.ts";

describe("remote lane config", () => {
	test("accepts only the distributed lane allowlist", () => {
		expect(parseRemoteLaneConfig(`
# probe-only rollout
REMOTE_LANE_URL=http://127.0.0.1:4891
REMOTE_LANE_SEND_ENABLED=0
UNRELATED_SECRET=do-not-load
`)).toEqual({
		REMOTE_LANE_URL: "http://127.0.0.1:4891",
		REMOTE_LANE_SEND_ENABLED: "0",
	});
	});
});

describe("distributed lane route selection", () => {
	test("keeps local when remote has no fresh application measurement", () => {
		expect(selectDistributedRoute({ localScoreMs: 20 })).toBe("local");
	});

	test("counts the complete internal RPC cost before selecting remote", () => {
		expect(selectDistributedRoute({
			localScoreMs: 20,
			remoteApplicationMs: 19,
			remoteRpcMs: 0.2,
			marginMs: 0.5,
		})).toBe("remote");
		expect(selectDistributedRoute({
			localScoreMs: 20,
			remoteApplicationMs: 19.4,
			remoteRpcMs: 0.2,
			marginMs: 0.5,
		})).toBe("local");
	});

	test("does not hide remote queueing behind a fast RTT", () => {
		expect(selectDistributedRoute({
			localScoreMs: 21,
			remoteApplicationMs: 17,
			remoteRpcMs: 0.2,
			remoteInFlight: 1,
			marginMs: 0.5,
		})).toBe("local");
	});

	test("uses a proven remote route when local has no fresh hot route", () => {
		expect(selectDistributedRoute({
			remoteApplicationMs: 18,
			remoteRpcMs: 0.25,
		})).toBe("remote");
	});
});
