import { db } from "../db/sqlite.ts";
import type { RuleRow, RuleSurface, Surface } from "../db/schema.ts";

export interface Rule {
	id: number;
	botId: number;
	surface: RuleSurface;
	matchType: "equals" | "startsWith" | "regex" | "containsAny";
	matchValue: string;
	replyText: string;
	enabled: boolean;
	priority: number;
}

function fromRow(row: RuleRow): Rule {
	return {
		id: row.id,
		botId: row.bot_id,
		surface: row.surface,
		matchType: row.match_type,
		matchValue: row.match_value,
		replyText: row.reply_text,
		enabled: row.enabled === 1,
		priority: row.priority,
	};
}

const listStmt = db.prepare<RuleRow, [number]>(
	"SELECT * FROM rules WHERE bot_id = ? ORDER BY priority DESC, id ASC",
);
const insertStmt = db.prepare<RuleRow, [number, RuleSurface, string, string, string, number, number, number]>(
	"INSERT INTO rules (bot_id, surface, match_type, match_value, reply_text, enabled, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
);
const updateStmt = db.prepare<null, [RuleSurface, string, string, string, number, number, number, number]>(
	"UPDATE rules SET surface = ?, match_type = ?, match_value = ?, reply_text = ?, enabled = ?, priority = ? WHERE id = ? AND bot_id = ?",
);
const deleteStmt = db.prepare<null, [number, number]>("DELETE FROM rules WHERE id = ? AND bot_id = ?");

export function listRules(botId: number): Rule[] {
	return listStmt.all(botId).map(fromRow);
}

/**
 * A rule with its matcher already built. Regex rules compile their pattern
 * once here instead of on every inbound message, and an invalid pattern
 * collapses to a matcher that never fires rather than throwing per message.
 */
export interface CompiledRule extends Rule {
	test(text: string): boolean;
}

// RAM mirror of the rules table, keyed by bot. Every inbound message
// consults this; SQLite stays the durable copy but is never read on the
// hot path. Any mutation below drops the affected entry, so a stale cache
// cannot outlive the write that invalidated it.
const compiledCache = new Map<number, CompiledRule[]>();
const MAX_REGEX_PATTERN_LENGTH = Number(process.env.RULE_REGEX_MAX_PATTERN ?? 512);
const MAX_MATCH_TEXT_LENGTH = Number(process.env.RULE_MATCH_MAX_TEXT ?? 4096);
const MAX_REPLY_TEXT_LENGTH = Number(process.env.RULE_REPLY_MAX_TEXT ?? 4096);

function potentiallyUnsafeRegex(source: string): boolean {
	if (source.length > MAX_REGEX_PATTERN_LENGTH) return true;
	// Reject the common catastrophic-backtracking shape: a repeated group
	// that itself contains a repeat, e.g. `(a+)+` or `(.*){2,}`.
	return /\((?:[^()\\]|\\.)*[*+{](?:[^()\\]|\\.)*\)\s*(?:[*+]|\{)/.test(source);
}

export class RuleValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RuleValidationError";
	}
}

function assertRuleInput(input: RuleInput): void {
	if (!input || !["talk", "square", "all"].includes(input.surface)) {
		throw new RuleValidationError("surface must be talk, square, or all");
	}
	if (!["equals", "startsWith", "regex", "containsAny"].includes(input.matchType)) {
		throw new RuleValidationError("unsupported matchType");
	}
	if (typeof input.matchValue !== "string" || !input.matchValue.trim()) {
		throw new RuleValidationError("matchValue is required");
	}
	if (input.matchValue.length > MAX_MATCH_TEXT_LENGTH) {
		throw new RuleValidationError(`matchValue must not exceed ${MAX_MATCH_TEXT_LENGTH} characters`);
	}
	if (typeof input.replyText !== "string" || !input.replyText.trim()) {
		throw new RuleValidationError("replyText is required");
	}
	if (input.replyText.length > MAX_REPLY_TEXT_LENGTH) {
		throw new RuleValidationError(`replyText must not exceed ${MAX_REPLY_TEXT_LENGTH} characters`);
	}
	if (typeof input.enabled !== "boolean") {
		throw new RuleValidationError("enabled must be boolean");
	}
	if (!Number.isInteger(input.priority)) {
		throw new RuleValidationError("priority must be an integer");
	}
	if (input.matchType === "regex") {
		if (potentiallyUnsafeRegex(input.matchValue)) {
			throw new RuleValidationError("regex is too long or unsafe");
		}
		try {
			new RegExp(input.matchValue);
		} catch {
			throw new RuleValidationError("regex is invalid");
		}
	}
}

function compile(rule: Rule): CompiledRule {
	let test: (text: string) => boolean;
	switch (rule.matchType) {
		case "equals":
			test = (text) => text === rule.matchValue;
			break;
		case "startsWith":
			test = (text) => text.startsWith(rule.matchValue);
			break;
		case "regex": {
			let pattern: RegExp | undefined;
			try {
				pattern = potentiallyUnsafeRegex(rule.matchValue)
					? undefined
					: new RegExp(rule.matchValue);
			} catch {
				pattern = undefined;
			}
			test = pattern ? (text) => pattern.test(text) : () => false;
			break;
		}
		case "containsAny": {
			const keywords = rule.matchValue.split(",").map((k) => k.trim()).filter(Boolean);
			test = (text) => keywords.some((k) => text.includes(k));
			break;
		}
	}
	return { ...rule, test };
}

/**
 * Rules for `botId`, compiled and cached in memory. Safe to call on every
 * inbound message — only the first call after a change touches SQLite.
 */
export function getCompiledRules(botId: number): CompiledRule[] {
	let cached = compiledCache.get(botId);
	if (!cached) {
		cached = listRules(botId).map(compile);
		compiledCache.set(botId, cached);
	}
	return cached;
}

/** Loads a bot's rules into memory ahead of its first message. */
export function preloadRules(botId: number): number {
	compiledCache.delete(botId);
	return getCompiledRules(botId).length;
}

export function invalidateRules(botId: number): void {
	compiledCache.delete(botId);
}

export interface RuleInput {
	surface: RuleSurface;
	matchType: Rule["matchType"];
	matchValue: string;
	replyText: string;
	enabled: boolean;
	priority: number;
}

export function createRule(botId: number, input: RuleInput): Rule {
	assertRuleInput(input);
	const row = insertStmt.get(
		botId,
		input.surface,
		input.matchType,
		input.matchValue,
		input.replyText,
		input.enabled ? 1 : 0,
		input.priority,
		Date.now(),
	);
	// Rebuild while handling the dashboard mutation. The next inbound
	// message must never be the one that reads SQLite and compiles regexes.
	preloadRules(botId);
	return fromRow(row!);
}

export function updateRule(botId: number, id: number, input: RuleInput): boolean {
	assertRuleInput(input);
	const result = updateStmt.run(
		input.surface,
		input.matchType,
		input.matchValue,
		input.replyText,
		input.enabled ? 1 : 0,
		input.priority,
		id,
		botId,
	);
	if (result.changes > 0) preloadRules(botId);
	return result.changes > 0;
}

export function deleteRule(botId: number, id: number): boolean {
	const result = deleteStmt.run(id, botId);
	if (result.changes > 0) preloadRules(botId);
	return result.changes > 0;
}

/**
 * First enabled match wins (rules already ordered by priority desc, id
 * asc). The bot exists to answer fast, not to be clever — keep matching
 * O(rules) and trivial rather than adding NLP/fuzzy scoring.
 */
export function matchRule(
	rules: CompiledRule[],
	text: string,
	surface?: Surface,
): CompiledRule | undefined {
	if (text.length > MAX_MATCH_TEXT_LENGTH) text = text.slice(0, MAX_MATCH_TEXT_LENGTH);
	for (const rule of rules) {
		if (!rule.enabled) continue;
		if (surface !== undefined && rule.surface !== "all" && rule.surface !== surface) continue;
		if (rule.test(text)) return rule;
	}
	return undefined;
}
