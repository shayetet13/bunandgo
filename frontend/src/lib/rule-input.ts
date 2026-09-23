import type { Rule } from "./types.ts";

type MatchType = Rule["matchType"];

export interface RuleMatchGuide {
	placeholder: string;
	help: string;
}

export interface RuleMatchFeedback {
	valid: boolean;
	message: string;
}

export const RULE_MATCH_GUIDES: Record<MatchType, RuleMatchGuide> = {
	equals: {
		placeholder: "เช่น จอง 14",
		help: "ต้องตรงทั้งข้อความ เช่น คีย์ “จอง 14” จะไม่ตรงกับ “ขอจอง 14” · รองรับภาษาไทย อังกฤษ ตัวเลข และสัญลักษณ์",
	},
	startsWith: {
		placeholder: "เช่น จอง",
		help: "จับทุกข้อความที่ขึ้นต้นด้วยคีย์ เช่น “จอง 14” และ “จองรถ” · รองรับภาษาไทย อังกฤษ ตัวเลข และสัญลักษณ์",
	},
	containsAny: {
		placeholder: "เช่น 14,15,16,test,car",
		help: "ใส่ได้หลายคีย์ คั่นด้วยจุลภาคอังกฤษ (,) เช่น 14,15,16,test,car · เว้นวรรครอบจุลภาคได้",
	},
	regex: {
		placeholder: "เช่น ^(จอง|ยกเลิก)\\s*\\d+$",
		help: "รูปแบบขั้นสูงสำหรับหลายเงื่อนไขในกฎเดียว เช่น ^(จอง|ยกเลิก)\\s*\\d+$ · ยาวไม่เกิน 512 ตัวอักษร",
	},
};

const MAX_MATCH_TEXT_LENGTH = 4096;
const MAX_REGEX_PATTERN_LENGTH = 512;

function potentiallyUnsafeRegex(source: string): boolean {
	if (source.length > MAX_REGEX_PATTERN_LENGTH) return true;
	return /\((?:[^()\\]|\\.)*[*+{](?:[^()\\]|\\.)*\)\s*(?:[*+]|\{)/.test(source);
}

/** Client-side guidance; the backend repeats these checks as the authority. */
export function validateRuleMatchValue(matchType: MatchType, rawValue: string): string | undefined {
	if (!rawValue.trim()) {
		return `กรุณากรอกคีย์ ตัวอย่างที่ถูกต้อง: ${RULE_MATCH_GUIDES[matchType].placeholder.replace(/^เช่น\s*/, "")}`;
	}
	if (rawValue.length > MAX_MATCH_TEXT_LENGTH) return `คีย์ต้องยาวไม่เกิน ${MAX_MATCH_TEXT_LENGTH} ตัวอักษร`;

	if (matchType === "containsAny") {
		if (rawValue.includes("，")) {
			return "รูปแบบคีย์ไม่ถูกต้อง — ใช้จุลภาคอังกฤษ (,) คั่นแต่ละคีย์ ตัวอย่าง: 14,15,16,test,car";
		}
		if (rawValue.split(",").some((keyword) => !keyword.trim())) {
			return "รูปแบบคีย์ไม่ถูกต้อง — ห้ามมีคีย์ว่าง จุลภาคซ้อน หรือต่อท้ายด้วยจุลภาค ตัวอย่าง: 14,15,16,test,car";
		}
	}

	if (matchType === "regex") {
		if (potentiallyUnsafeRegex(rawValue)) {
			return "regex ยาวเกินไปหรือไม่ปลอดภัย — ตัวอย่าง: ^(จอง|ยกเลิก)\\s*\\d+$";
		}
		try {
			new RegExp(rawValue);
		} catch {
			return "regex ไม่ถูกต้อง — ตรวจวงเล็บและอักขระพิเศษ ตัวอย่าง: ^(จอง|ยกเลิก)\\s*\\d+$";
		}
	}

	return undefined;
}

function quotedPreview(value: string): string {
	const compact = value.trim().replace(/\s+/g, " ");
	return `“${compact.length > 60 ? `${compact.slice(0, 57)}…` : compact}”`;
}

/** Real-time explanation so arbitrary-but-valid literal keys are not mistaken for missing validation. */
export function ruleMatchFeedback(matchType: MatchType, rawValue: string): RuleMatchFeedback | undefined {
	if (rawValue.length === 0) return undefined;
	const error = validateRuleMatchValue(matchType, rawValue);
	if (error) return { valid: false, message: error };

	switch (matchType) {
		case "equals":
			return { valid: true, message: `รูปแบบถูกต้อง — บอทจะตอบเมื่อข้อความตรงกับ ${quotedPreview(rawValue)} ทุกตัวอักษร` };
		case "startsWith":
			return { valid: true, message: `รูปแบบถูกต้อง — บอทจะตอบทุกข้อความที่ขึ้นต้นด้วย ${quotedPreview(rawValue)}` };
		case "containsAny": {
			const count = rawValue.split(",").length;
			return { valid: true, message: `รูปแบบถูกต้อง — ระบบพบ ${count} คีย์ และจะตอบเมื่อข้อความมีคีย์ใดคีย์หนึ่ง` };
		}
		case "regex":
			return { valid: true, message: "regex ถูกต้องและพร้อมใช้งาน" };
	}
}
