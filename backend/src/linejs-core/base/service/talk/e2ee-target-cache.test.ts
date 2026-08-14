import { describe, expect, test } from "bun:test";
import { TalkService } from "./mod.ts";
import { CompactMessageProtocolError } from "./compact.ts";

const RESULT = { sequenceId: 1, messageId: 1n, createdTime: 1 };

function mockClient(values = new Map<string, unknown>(), onEncrypt?: (to: string) => void) {
	return {
		storage: {
			async get(key: string) { return values.get(key); },
			async set(key: string, value: unknown) { values.set(key, value); },
		},
		e2ee: {
			async encryptE2EEMessage(to: string) {
				onEncrypt?.(to);
				return [];
			},
		},
	} as never;
}

describe("TalkService compact E2EE target cache", () => {
	test("a target that requests encryption skips the failed plain RTT thereafter", async () => {
		const service = new TalkService(mockClient());
		let plainCalls = 0;
		let encryptedCalls = 0;
		service.sendCompactPlainMessage = async () => {
			plainCalls++;
			throw new CompactMessageProtocolError("encrypt", 82);
		};
		service.sendCompactE2EEMessage = async () => {
			encryptedCalls++;
			return RESULT;
		};

		await service.sendCompactMessage({ to: "c" + "a".repeat(32), text: "first" });
		await service.sendCompactMessage({ to: "c" + "a".repeat(32), text: "second" });

		expect(plainCalls).toBe(1);
		expect(encryptedCalls).toBe(2);
	});

	test("explicit E2EE teaches the cache for later sends", async () => {
		const service = new TalkService(mockClient());
		let plainCalls = 0;
		let encryptedCalls = 0;
		service.sendCompactPlainMessage = async () => {
			plainCalls++;
			return RESULT;
		};
		service.sendCompactE2EEMessage = async () => {
			encryptedCalls++;
			return RESULT;
		};
		const target = "c" + "b".repeat(32);

		await service.sendCompactMessage({ to: target, text: "first", e2ee: true });
		await service.sendCompactMessage({ to: target, text: "second" });

		expect(plainCalls).toBe(0);
		expect(encryptedCalls).toBe(2);
	});

	test("persists the learned policy across client restarts", async () => {
		const values = new Map<string, unknown>();
		const target = "c" + "c".repeat(32);
		const first = new TalkService(mockClient(values));
		first.sendCompactPlainMessage = async () => {
			throw new CompactMessageProtocolError("encrypt", 82);
		};
		first.sendCompactE2EEMessage = async () => RESULT;
		await first.sendCompactMessage({ to: target, text: "learn" });

		const restarted = new TalkService(mockClient(values));
		let plainCalls = 0;
		restarted.sendCompactPlainMessage = async () => {
			plainCalls++;
			return RESULT;
		};
		restarted.sendCompactE2EEMessage = async () => RESULT;
		await restarted.sendCompactMessage({ to: target, text: "after restart" });

		expect(plainCalls).toBe(0);
	});

	test("prewarms a persisted E2EE target without sending", async () => {
		const target = "c" + "d".repeat(32);
		const values = new Map<string, unknown>([[`compactE2EETarget:${target}`, true]]);
		const encrypted: string[] = [];
		const service = new TalkService(mockClient(values, (to) => encrypted.push(to)));

		expect(await service.prewarmCompactE2EETarget(target)).toBe(true);
		expect(encrypted).toEqual([target]);
	});
});
