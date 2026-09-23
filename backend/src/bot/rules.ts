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

const listStmt = db.prepare<RuleRow, [number]>("SELECT * FROM rules WHERE bot_id = ? ORDER BY priority DESC, id ASC");
const countStmt = db.prepare<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM rules WHERE bot_id = ?");
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
/** Beyond this many rules, a bot's own admin has bloated the linear per-message scan; new rules stop being accepted. */
const MAX_RULES_PER_BOT = Number(process.env.RULE_MAX_PER_BOT ?? 500);

function potentiallyUnsafeRegex(source: string): boolean {
	if (source.length > MAX_REGEX_PATTERN_LENGTH) return true;
	// Reject the common catastrophic-backtracking shape: a repeated group
	// that itself contains a repeat, e.g. `(a+)+` or `(.*){2,}`.
	if (/\((?:[^()\\]|\\.)*[*+{](?:[^()\\]|\\.)*\)\s*(?:[*+]|\{)/.test(source)) return true;
	// Reject the equally catastrophic "ambiguous alternation" shape: a
	// quantified group whose branches can match the same text, e.g. `(a|a)+`
	// or `(a|ab)*` — this was the shape the nested-quantifier check above
	// missed (confirmed: matching
	// `(a|a)+$` against 26 "a"s took ~430ms on this box; a genuine LINE
	// message is tested on the single-threaded event loop that every other
	// bot's replies and every API request share, so this alone can freeze the
	// whole process for every tenant). Structural, so it holds regardless of
	// which literal character the pattern actually repeats.
	return /\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)\s*(?:[*+]|\{)/.test(source);
}

/**
 * Adversarial probe test, run once per pattern (rule save, or cache reload
 * after a restart) rather than per message — a bounded one-time cost is fine
 * for an admin action or a startup reload, the way it would not be for a
 * per-message hot path. Backstops `potentiallyUnsafeRegex` against a
 * catastrophic-backtracking shape the structural check does not anticipate:
 * this measures actual behaviour instead of trying to classify the pattern.
 *
 * Probe length is deliberately short — long enough that a genuinely
 * catastrophic pattern is already unusably slow (see the `(a|a)+$` timing
 * above), short enough that even an undetected bad pattern's one-time test
 * here stays well under a second rather than growing to minutes.
 */
const REDOS_PROBE_LENGTH = 26;
const REDOS_PROBE_BUDGET_MS = Number(process.env.RULE_REGEX_PROBE_BUDGET_MS ?? 200);

/** Literal letters/digits from the pattern itself, so a probe built from them can actually reach a repeated group whose branches use script-specific characters (Thai, etc.) instead of only ASCII. */
function distinctLiteralChars(source: string, limit: number): string[] {
	const matches = source.match(/[\p{L}\p{N}]/gu) ?? [];
	return [...new Set(matches)].slice(0, limit);
}

function redosProbeInputs(source: string): string[] {
	const chars = distinctLiteralChars(source, 3);
	const probeChars = chars.length > 0 ? chars : ["a", "0"];
	return probeChars.map((ch) => ch.repeat(REDOS_PROBE_LENGTH) + "!");
}

/** True when the pattern takes catastrophically long against its own probe inputs. */
function isSlowRegex(pattern: RegExp, source: string): boolean {
	const probes = redosProbeInputs(source);
	const start = performance.now();
	for (const probe of probes) pattern.test(probe);
	return performance.now() - start > REDOS_PROBE_BUDGET_MS;
}

const CONTAINS_ANY_EXAMPLE = "14,15,16,test,car";

function assertContainsAnyKeyFormat(value: string): void {
	if (value.includes("，")) {
		throw new RuleValidationError(
			`รูปแบบคีย์ไม่ถูกต้อง — กรุณาใช้เครื่องหมายจุลภาคอังกฤษ (,) คั่นแต่ละคีย์ ตัวอย่าง: ${CONTAINS_ANY_EXAMPLE}`,
		);
	}
	const keywords = value.split(",");
	if (keywords.some((keyword) => !keyword.trim())) {
		throw new RuleValidationError(
			`รูปแบบคีย์ไม่ถูกต้อง — ห้ามมีคีย์ว่าง เครื่องหมายจุลภาคซ้อน หรือต่อท้ายด้วยจุลภาค ตัวอย่างที่ถูกต้อง: ${CONTAINS_ANY_EXAMPLE}`,
		);
	}
}

export class RuleValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RuleValidationError";
	}
}

function assertRuleInput(input: RuleInput): void {
	if (!input || !["talk", "square", "oa", "all"].includes(input.surface)) {
		throw new RuleValidationError("ประเภทห้องไม่ถูกต้อง — กรุณาเลือก กลุ่มแชท, OpenChat, OA หรือทุกประเภท");
	}
	if (!["equals", "startsWith", "regex", "containsAny"].includes(input.matchType)) {
		throw new RuleValidationError("ประเภทเงื่อนไขไม่ถูกต้อง");
	}
	if (typeof input.matchValue !== "string" || !input.matchValue.trim()) {
		throw new RuleValidationError("กรุณากรอกคีย์ที่ใช้จับข้อความ เช่น 14,15,16,test,car");
	}
	if (input.matchValue.length > MAX_MATCH_TEXT_LENGTH) {
		throw new RuleValidationError(`คีย์ต้องยาวไม่เกิน ${MAX_MATCH_TEXT_LENGTH} ตัวอักษร`);
	}
	if (typeof input.replyText !== "string" || !input.replyText.trim()) {
		throw new RuleValidationError("กรุณากรอกข้อความที่ต้องการให้บอทตอบกลับ");
	}
	if (input.replyText.length > MAX_REPLY_TEXT_LENGTH) {
		throw new RuleValidationError(`ข้อความตอบกลับต้องยาวไม่เกิน ${MAX_REPLY_TEXT_LENGTH} ตัวอักษร`);
	}
	if (typeof input.enabled !== "boolean") {
		throw new RuleValidationError("enabled must be boolean");
	}
	if (!Number.isInteger(input.priority)) {
		throw new RuleValidationError("priority must be an integer");
	}
	if (input.matchType === "containsAny") assertContainsAnyKeyFormat(input.matchValue);
	if (input.matchType === "regex") {
		if (potentiallyUnsafeRegex(input.matchValue)) {
			throw new RuleValidationError("regex ยาวเกินไปหรือไม่ปลอดภัย — ตัวอย่างที่ถูกต้อง: ^(จอง|ยกเลิก)\\s*\\d+$");
		}
		let compiled: RegExp;
		try {
			compiled = new RegExp(input.matchValue);
		} catch {
			throw new RuleValidationError("regex ไม่ถูกต้อง — ตรวจวงเล็บและอักขระพิเศษ ตัวอย่าง: ^(จอง|ยกเลิก)\\s*\\d+$");
		}
		if (isSlowRegex(compiled, input.matchValue)) {
			throw new RuleValidationError("regex ไม่ปลอดภัย — ใช้เวลาประมวลผลนานเกินไปกับข้อความทดสอบ ลองทำ pattern ให้ง่ายขึ้น");
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
				pattern = potentiallyUnsafeRegex(rule.matchValue) ? undefined : new RegExp(rule.matchValue);
			} catch {
				pattern = undefined;
			}
			// Re-checked here, not only in assertRuleInput: a rule saved before
			// this check existed (or before potentiallyUnsafeRegex covered its
			// particular shape) must not keep matching unsafely just because it
			// predates the fix — every process restart reloads rules through
			// this same path, so a fixed-and-redeployed check is enough on its
			// own, no migration needed.
			if (pattern && isSlowRegex(pattern, rule.matchValue)) pattern = undefined;
			test = pattern ? (text) => pattern.test(text) : () => false;
			break;
		}
		case "containsAny": {
			const keywords = rule.matchValue
				.split(",")
				.map((k) => k.trim())
				.filter(Boolean);
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
	if ((countStmt.get(botId)?.n ?? 0) >= MAX_RULES_PER_BOT) {
		throw new RuleValidationError(`บอทนี้มีเงื่อนไขครบ ${MAX_RULES_PER_BOT} ข้อแล้ว — กรุณาลบเงื่อนไขที่ไม่ใช้ก่อนเพิ่มใหม่`);
	}
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
export function matchRule(rules: CompiledRule[], text: string, surface?: Surface): CompiledRule | undefined {
	if (text.length > MAX_MATCH_TEXT_LENGTH) text = text.slice(0, MAX_MATCH_TEXT_LENGTH);
	for (const rule of rules) {
		if (!rule.enabled) continue;
		if (surface !== undefined && rule.surface !== "all" && rule.surface !== surface) continue;
		if (rule.test(text)) return rule;
	}
	return undefined;
}
