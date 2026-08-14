import { describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { sharedKey } from "curve25519-js";
import E2EE from "./mod.ts";

const SELF = "u00000000000000000000000000000001";
const PEER = "u00000000000000000000000000000002";

function makeClient(preloadPeer: boolean) {
	const self = nacl.box.keyPair();
	const peer = nacl.box.keyPair();
	const values = new Map<string, unknown>();
	values.set(`e2eeKeys:${SELF}`, JSON.stringify({
		keyId: 1,
		privKey: Buffer.from(self.secretKey).toString("base64"),
		pubKey: Buffer.from(self.publicKey).toString("base64"),
	}));
	if (preloadPeer) {
		values.set("e2eePublicKeys:2", Buffer.from(peer.publicKey).toString("base64"));
	}
	let negotiations = 0;
	const client = {
		profile: { mid: SELF },
		getToType: (mid: string) => mid.startsWith("u") ? 0 : 2,
		log() {},
		storage: {
			async get(key: string) {
				return values.get(key);
			},
			async set(key: string, value: unknown) {
				values.set(key, value);
			},
		},
		talk: {
			async negotiateE2EEPublicKey() {
				negotiations++;
				return {
					specVersion: 2,
					publicKey: { keyId: 2, keyData: peer.publicKey },
				};
			},
		},
	} as any;
	return { client, negotiations: () => negotiations };
}

describe("E2EE hot cache", () => {
	test("native X25519 matches the existing Curve25519 implementation", () => {
		const e2ee = new E2EE({ debugLogsEnabled: false, log() {} } as any);
		for (let i = 0; i < 16; i++) {
			const local = nacl.box.keyPair();
			const peer = nacl.box.keyPair();
			const expected = Buffer.from(sharedKey(local.secretKey, peer.publicKey));
			const actual = Buffer.from(e2ee.generateSharedSecret(
				Buffer.from(local.secretKey),
				Buffer.from(peer.publicKey),
			));
			expect(actual.equals(expected)).toBe(true);
		}
	});

	test("can prewarm the complete local crypto path repeatedly", () => {
		const e2ee = new E2EE({ debugLogsEnabled: false, log() {} } as any);
		expect(() => {
			e2ee.prewarmCrypto();
			e2ee.prewarmCrypto();
			e2ee.prewarmCrypto();
		}).not.toThrow();
	});

	test("reuses the decrypt shared secret while envelope key ids stay unchanged", () => {
		const e2ee = new E2EE({ debugLogsEnabled: false, log() {} } as any);
		const local = nacl.box.keyPair();
		const peer = nacl.box.keyPair();
		const to = "c00000000000000000000000000000001";
		const from = PEER;
		const shared = Buffer.from(e2ee.generateSharedSecret(
			Buffer.from(local.secretKey),
			Buffer.from(peer.publicKey),
		));
		const chunks = e2ee.encryptE2EETextMessage(2, 1, shared, 2, "cached", to, from);
		const original = e2ee.generateSharedSecret.bind(e2ee);
		let generated = 0;
		e2ee.generateSharedSecret = ((privateKey: Buffer, publicKey: Buffer) => {
			generated++;
			return original(privateKey, publicKey);
		}) as typeof e2ee.generateSharedSecret;

		expect(e2ee.decryptE2EEMessageV2(
			to,
			from,
			chunks,
			Buffer.from(local.secretKey),
			Buffer.from(peer.publicKey),
		)).toEqual({ text: "cached" });
		expect(e2ee.decryptE2EEMessageV2(
			to,
			from,
			chunks,
			Buffer.from(local.secretKey),
			Buffer.from(peer.publicKey),
		)).toEqual({ text: "cached" });
		expect(generated).toBe(1);
	});

	test("reuses the sender key learned while decrypting for the reply", async () => {
		const mock = makeClient(true);
		const e2ee = new E2EE(mock.client);
		await e2ee.getE2EELocalPublicKey(PEER, 2);

		const chunks = await e2ee.encryptE2EEMessage(PEER, "reply");

		expect(chunks).toHaveLength(5);
		expect(mock.negotiations()).toBe(0);
	});

	test("negotiates once on a cold target and then stays in RAM", async () => {
		const mock = makeClient(false);
		const e2ee = new E2EE(mock.client);

		await e2ee.encryptE2EEMessage(PEER, "first");
		await e2ee.encryptE2EEMessage(PEER, "second");

		expect(mock.negotiations()).toBe(1);
	});
});
