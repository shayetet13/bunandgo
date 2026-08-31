import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

const { createRule, deleteRule, getCompiledRules, matchRule, preloadRules, updateRule } = await import("./rules.ts");
const { createBot, isOwnerTestingEnabled, listBots, updateOwnerTesting } = await import("./bots.ts");
const { db } = await import("../db/sqlite.ts");

const BOT = 1;

const baseInput = {
	surface: "talk" as const,
	matchType: "equals" as const,
	matchValue: "14,15,16",
	replyText: "จองแล้ว",
	enabled: true,
	priority: 0,
};

beforeAll(() => {
	db.exec("DELETE FROM kv; DELETE FROM bots; DELETE FROM rules;");
});

beforeEach(() => {
	db.exec("DELETE FROM rules");
	preloadRules(BOT);
});

describe("owner testing setting", () => {
	test("is disabled for a new bot and can be toggled", () => {
		const bot = createBot("test owner mode");
		expect(bot.allowOwnerTesting).toBe(false);
		expect(isOwnerTestingEnabled(bot.id)).toBe(false);

		expect(updateOwnerTesting(bot.id, true)?.allowOwnerTesting).toBe(true);
		expect(isOwnerTestingEnabled(bot.id)).toBe(true);
		expect(listBots().find((item) => item.id === bot.id)?.allowOwnerTesting).toBe(true);

		expect(updateOwnerTesting(bot.id, false)?.allowOwnerTesting).toBe(false);
		expect(isOwnerTestingEnabled(bot.id)).toBe(false);
	});

	test("does not create a setting for a missing bot", () => {
		expect(updateOwnerTesting(999_999, true)).toBeUndefined();
	});
});

describe("getCompiledRules", () => {
	test("sees a rule added after the cache was populated", () => {
		expect(getCompiledRules(BOT)).toHaveLength(0);

		createRule(BOT, baseInput);

		expect(getCompiledRules(BOT)).toHaveLength(1);
	});

	test("stops serving a rule that was deleted", () => {
		const rule = createRule(BOT, baseInput);
		getCompiledRules(BOT);

		deleteRule(BOT, rule.id);

		expect(getCompiledRules(BOT)).toHaveLength(0);
	});

	test("serves the new reply text after an edit", () => {
		const rule = createRule(BOT, baseInput);
		getCompiledRules(BOT);

		updateRule(BOT, rule.id, { ...baseInput, replyText: "ปิดรอบแล้ว" });

		expect(getCompiledRules(BOT)[0]?.replyText).toBe("ปิดรอบแล้ว");
	});

	test("applies a changed match value instead of the cached one", () => {
		const rule = createRule(BOT, baseInput);
		expect(matchRule(getCompiledRules(BOT), "14,15,16")).toBeDefined();

		updateRule(BOT, rule.id, { ...baseInput, matchValue: "20,21" });

		expect(matchRule(getCompiledRules(BOT), "14,15,16")).toBeUndefined();
		expect(matchRule(getCompiledRules(BOT), "20,21")).toBeDefined();
	});

	test("keeps one bot's rules out of another's", () => {
		createRule(BOT, baseInput);

		expect(getCompiledRules(2)).toHaveLength(0);
	});
});

describe("matchRule", () => {
	test("matches an exact rule only on the exact text", () => {
		createRule(BOT, baseInput);
		const rules = getCompiledRules(BOT);

		expect(matchRule(rules, "14,15,16")).toBeDefined();
		expect(matchRule(rules, "14,15,16 นะ")).toBeUndefined();
	});

	test("matches a prefix rule on anything starting with it", () => {
		createRule(BOT, { ...baseInput, matchType: "startsWith", matchValue: "จอง" });
		const rules = getCompiledRules(BOT);

		expect(matchRule(rules, "จอง 14")).toBeDefined();
		expect(matchRule(rules, "ขอจอง 14")).toBeUndefined();
	});

	test("matches a regex rule", () => {
		createRule(BOT, { ...baseInput, matchType: "regex", matchValue: "^(14|15|16)$" });
		const rules = getCompiledRules(BOT);

		expect(matchRule(rules, "15")).toBeDefined();
		expect(matchRule(rules, "17")).toBeUndefined();
	});

	test("rejects a regex that does not compile", () => {
		expect(() => createRule(BOT, { ...baseInput, matchType: "regex", matchValue: "([unclosed" })).toThrow("regex ไม่ถูกต้อง");
		expect(getCompiledRules(BOT)).toHaveLength(0);
	});

	test("rejects the nested-quantifier catastrophic-backtracking shape", () => {
		expect(() => createRule(BOT, { ...baseInput, matchType: "regex", matchValue: "(a+)+$" })).toThrow("ไม่ปลอดภัย");
		expect(getCompiledRules(BOT)).toHaveLength(0);
	});

	test("rejects the ambiguous-alternation catastrophic-backtracking shape", () => {
		// Regression test: this exact pattern passed the old check (only
		// caught a quantified group containing another quantifier) and froze
		// the process — `(a|a)+$` against 26 "a"s measured ~430ms on this box,
		// tested synchronously on the same event loop every bot and every API
		// request shares.
		expect(() => createRule(BOT, { ...baseInput, matchType: "regex", matchValue: "(a|a)+$" })).toThrow("ไม่ปลอดภัย");
		expect(getCompiledRules(BOT)).toHaveLength(0);
	});

	test("rejects an ambiguous alternation built from non-Latin literal characters", () => {
		// The probe backstop builds its adversarial input from the pattern's
		// own literal characters specifically so this does not slip past it
		// the way an ASCII-only probe would.
		expect(() => createRule(BOT, { ...baseInput, matchType: "regex", matchValue: "(จอง|จอง)+$" })).toThrow("ไม่ปลอดภัย");
		expect(getCompiledRules(BOT)).toHaveLength(0);
	});

	test("still accepts a normal alternation used the documented way", () => {
		const rule = createRule(BOT, { ...baseInput, matchType: "regex", matchValue: "^(จอง|ยกเลิก)\\s*\\d+$" });
		const rules = getCompiledRules(BOT);

		expect(rule.matchValue).toBe("^(จอง|ยกเลิก)\\s*\\d+$");
		expect(matchRule(rules, "จอง 15")).toBeDefined();
		expect(matchRule(rules, "ยกเลิก 3")).toBeDefined();
		expect(matchRule(rules, "อยากจอง 15")).toBeUndefined();
	});

	test("neutralizes an unsafe pattern already in the database on the next cache load, no migration needed", () => {
		// Simulates a rule saved before this check existed (or before
		// potentiallyUnsafeRegex covered this particular shape): write it to
		// SQLite directly, bypassing createRule's validation, then confirm a
		// fresh compile from that stored row also refuses to run it.
		db.exec(
			`INSERT INTO rules (bot_id, surface, match_type, match_value, reply_text, enabled, priority, created_at)
			 VALUES (${BOT}, 'talk', 'regex', '(a|a)+$', 'x', 1, 0, ${Date.now()})`,
		);
		preloadRules(BOT);

		expect(matchRule(getCompiledRules(BOT), "a".repeat(26))).toBeUndefined();
	});

	test("matches a containsAny rule when any comma-separated keyword appears", () => {
		createRule(BOT, { ...baseInput, matchType: "containsAny", matchValue: "14,15,16,test,car" });
		const rules = getCompiledRules(BOT);

		expect(matchRule(rules, "ขอจอง 15 คัน")).toBeDefined();
		expect(matchRule(rules, "test นี้")).toBeDefined();
		expect(matchRule(rules, "car ของฉัน")).toBeDefined();
		expect(matchRule(rules, "ไม่มีคำที่ตรงกัน")).toBeUndefined();
	});

	test("trims whitespace around containsAny keywords", () => {
		createRule(BOT, { ...baseInput, matchType: "containsAny", matchValue: " 14 , 15 , 16 " });
		const rules = getCompiledRules(BOT);

		expect(matchRule(rules, "จอง 15")).toBeDefined();
	});

	test("rejects empty containsAny keys and explains the correct format", () => {
		for (const matchValue of [",14", "14,,15", "14,"]) {
			expect(() => createRule(BOT, { ...baseInput, matchType: "containsAny", matchValue })).toThrow("14,15,16,test,car");
		}
		expect(getCompiledRules(BOT)).toHaveLength(0);
	});

	test("rejects a full-width comma with an English-comma example", () => {
		expect(() => createRule(BOT, { ...baseInput, matchType: "containsAny", matchValue: "14，15" })).toThrow("จุลภาคอังกฤษ");
	});

	test("skips a disabled rule", () => {
		createRule(BOT, { ...baseInput, enabled: false });

		expect(matchRule(getCompiledRules(BOT), "14,15,16")).toBeUndefined();
	});

	test("matches only on the surface selected by the rule", () => {
		createRule(BOT, { ...baseInput, surface: "talk" });

		expect(matchRule(getCompiledRules(BOT), "14,15,16", "talk")).toBeDefined();
		expect(matchRule(getCompiledRules(BOT), "14,15,16", "square")).toBeUndefined();
	});

	test("an all-surface rule matches Talk and OpenChat", () => {
		createRule(BOT, { ...baseInput, surface: "all" });
		const rules = getCompiledRules(BOT);

		expect(matchRule(rules, "14,15,16", "talk")).toBeDefined();
		expect(matchRule(rules, "14,15,16", "square")).toBeDefined();
	});

	test("refuses a new rule once the per-bot cap is reached", () => {
		// Matches the MAX_RULES_PER_BOT default in rules.ts (RULE_MAX_PER_BOT
		// env override) — this bounds the worst case of the linear per-message
		// scan in matchRule, the same way MAX_SQUARE_CHATS_PER_BOT bounds the
		// fast-poll room count in chat-access.ts.
		for (let i = 0; i < 500; i++) createRule(BOT, { ...baseInput, matchValue: `k${i}` });
		expect(getCompiledRules(BOT)).toHaveLength(500);

		expect(() => createRule(BOT, { ...baseInput, matchValue: "one-too-many" })).toThrow("ครบ");
		expect(getCompiledRules(BOT)).toHaveLength(500);
	});

	test("reports missing updates and deletes", () => {
		expect(updateRule(BOT, 999_999, baseInput)).toBe(false);
		expect(deleteRule(BOT, 999_999)).toBe(false);
	});

	test("prefers the higher priority rule when both match", () => {
		createRule(BOT, { ...baseInput, replyText: "ต่ำ", priority: 0 });
		createRule(BOT, { ...baseInput, replyText: "สูง", priority: 5 });

		expect(matchRule(getCompiledRules(BOT), "14,15,16")?.replyText).toBe("สูง");
	});

	test("returns a single rule even when several match", () => {
		createRule(BOT, { ...baseInput, matchType: "startsWith", matchValue: "14" });
		createRule(BOT, { ...baseInput, matchType: "startsWith", matchValue: "14,15" });

		// The bot sends one reply per match; matchRule returning the first
		// hit is what makes that possible.
		expect(matchRule(getCompiledRules(BOT), "14,15,16")).toBeDefined();
	});
});
