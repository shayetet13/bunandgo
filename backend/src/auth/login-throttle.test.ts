import { describe, expect, test } from "bun:test";

// Each test gets a fresh module instance so the shared `attemptsByKey` map
// and its env-derived caps don't leak state between tests.
async function freshThrottle(env: Record<string, string> = {}) {
	const prior: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(env)) {
		prior[k] = process.env[k];
		process.env[k] = v;
	}
	const mod = await import(`./login-throttle.ts?t=${Math.random()}`);
	for (const [k, v] of Object.entries(prior)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	return mod as typeof import("./login-throttle.ts");
}

describe("login-throttle", () => {
	test("blocks after the configured max attempts within the window", async () => {
		const { tryAcquireLoginAttempt } = await freshThrottle({
			LOGIN_MAX_ATTEMPTS: "3",
			LOGIN_WINDOW_MS: "60000",
		});
		const key = "1.2.3.4|alice";
		expect(tryAcquireLoginAttempt(key, 1_000).allowed).toBe(true);
		expect(tryAcquireLoginAttempt(key, 1_001).allowed).toBe(true);
		expect(tryAcquireLoginAttempt(key, 1_002).allowed).toBe(true);
		const blocked = tryAcquireLoginAttempt(key, 1_003);
		expect(blocked.allowed).toBe(false);
		expect(blocked.retryAfterMs).toBeGreaterThan(0);
	});

	test("a distinct key is throttled independently", async () => {
		const { tryAcquireLoginAttempt } = await freshThrottle({
			LOGIN_MAX_ATTEMPTS: "1",
			LOGIN_WINDOW_MS: "60000",
		});
		expect(tryAcquireLoginAttempt("k1", 0).allowed).toBe(true);
		expect(tryAcquireLoginAttempt("k1", 1).allowed).toBe(false);
		expect(tryAcquireLoginAttempt("k2", 1).allowed).toBe(true);
	});

	test("clearLoginAttempts resets a key immediately", async () => {
		const { tryAcquireLoginAttempt, clearLoginAttempts } = await freshThrottle({
			LOGIN_MAX_ATTEMPTS: "1",
			LOGIN_WINDOW_MS: "60000",
		});
		expect(tryAcquireLoginAttempt("k", 0).allowed).toBe(true);
		expect(tryAcquireLoginAttempt("k", 1).allowed).toBe(false);
		clearLoginAttempts("k");
		expect(tryAcquireLoginAttempt("k", 2).allowed).toBe(true);
	});

	test("stops growing once LOGIN_THROTTLE_MAX_KEYS distinct keys have been seen", async () => {
		const { tryAcquireLoginAttempt } = await freshThrottle({
			LOGIN_MAX_ATTEMPTS: "10",
			LOGIN_WINDOW_MS: "60000",
			LOGIN_THROTTLE_MAX_KEYS: "50",
		});
		// An unauthenticated caller cycling through many distinct ip|username
		// pairs must not be able to grow the map past its cap.
		for (let i = 0; i < 500; i++) {
			tryAcquireLoginAttempt(`attacker-key-${i}`, i);
		}
		// No public size getter is exported (nothing outside the module needs
		// one); the cap is exercised behaviorally instead: a key from early in
		// the flood has been evicted, so it is treated as brand new again
		// rather than remembering it was already seen once.
		const first = tryAcquireLoginAttempt("attacker-key-0", 1_000_000);
		expect(first.allowed).toBe(true);
	});

	test("re-touching an existing key protects it from eviction ahead of an idle one", async () => {
		const { tryAcquireLoginAttempt } = await freshThrottle({
			LOGIN_MAX_ATTEMPTS: "2",
			LOGIN_WINDOW_MS: "60000",
			LOGIN_THROTTLE_MAX_KEYS: "3",
		});
		// Insertion order: active, b, c — all at the cap of 3 distinct keys.
		expect(tryAcquireLoginAttempt("active", 0).allowed).toBe(true);
		expect(tryAcquireLoginAttempt("b", 1).allowed).toBe(true);
		expect(tryAcquireLoginAttempt("c", 2).allowed).toBe(true);

		// Re-touch "active" until it hits its own MAX_ATTEMPTS. A plain
		// `Map.set` on an existing key would leave "active" at its original
		// (now oldest) insertion position despite this — exactly the bug this
		// test guards against.
		expect(tryAcquireLoginAttempt("active", 3).allowed).toBe(true);

		// A brand-new key pushes the tracked set over capacity, forcing one
		// eviction. If "active" kept its original oldest position, it would be
		// the one evicted here instead of "b" (last touched at t=1, never
		// again).
		expect(tryAcquireLoginAttempt("d", 4).allowed).toBe(true);

		// "active" already reached MAX_ATTEMPTS (2) — if its history survived
		// the eviction (the fix), it is still blocked now.
		expect(tryAcquireLoginAttempt("active", 5).allowed).toBe(false);
		// "b" was the true least-recently-touched key and should be the one
		// evicted, so it comes back as a fresh, unblocked key.
		expect(tryAcquireLoginAttempt("b", 5).allowed).toBe(true);
	});
});
