import { describe, expect, test } from "bun:test";
import { createBot } from "./bots.ts";
import { createRule, deleteRule, updateRule } from "./rules.ts";

// session-manager.ts requires DISPATCH_TOKEN at module load (shared secret
// with backend/sender); set it before importing, same as routes.test.ts.
process.env.DISPATCH_TOKEN ??= "test-dispatch-token";
const { botCanAnswerSquare } = await import("./session-manager.ts");

const owner = 424242;

describe("botCanAnswerSquare (dedicated-poll eligibility gate)", () => {
	const rule = (surface: "square" | "all" | "talk" | "oa", enabled: boolean) => ({
		surface,
		matchType: "containsAny" as const,
		matchValue: "x",
		replyText: "y",
		enabled,
		priority: 0,
	});

	test("false with no rules, an OA/Talk-only rule, or only a disabled Square rule", () => {
		const bot = createBot("no square rule", "DESKTOPWIN", owner);
		expect(botCanAnswerSquare(bot.id)).toBe(false);
		createRule(bot.id, rule("talk", true));
		createRule(bot.id, rule("oa", true));
		const disabled = createRule(bot.id, rule("square", false));
		expect(botCanAnswerSquare(bot.id)).toBe(false);
		updateRule(bot.id, disabled.id, rule("square", true));
		expect(botCanAnswerSquare(bot.id)).toBe(true);
	});

	test("true with an enabled square or all rule, false again once it is removed", () => {
		const bot = createBot("has square rule", "DESKTOPWIN", owner);
		const r = createRule(bot.id, rule("all", true));
		expect(botCanAnswerSquare(bot.id)).toBe(true);
		deleteRule(bot.id, r.id);
		expect(botCanAnswerSquare(bot.id)).toBe(false);
	});
});
