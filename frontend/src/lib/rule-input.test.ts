import { describe, expect, test } from "bun:test";
import { RULE_MATCH_GUIDES, ruleMatchFeedback, validateRuleMatchValue } from "./rule-input.ts";

describe("rule match input", () => {
	test("accepts flexible Thai, English, and numeric keys", () => {
		expect(validateRuleMatchValue("containsAny", "จองรถ,booking,14,รถสีแดง")).toBeUndefined();
		expect(validateRuleMatchValue("containsAny", " 14 , 15 , ทดสอบ ")).toBeUndefined();
		expect(validateRuleMatchValue("containsAny", "คีย์เดียว")).toBeUndefined();
	});

	test("explains malformed comma-separated keys with a correct example", () => {
		for (const value of [",14", "14,,15", "14,"]) {
			expect(validateRuleMatchValue("containsAny", value)).toContain("14,15,16,test,car");
		}
		expect(validateRuleMatchValue("containsAny", "14，15")).toContain("จุลภาคอังกฤษ");
	});

	test("explains invalid regex input", () => {
		expect(validateRuleMatchValue("regex", "([unclosed")).toContain("regex ไม่ถูกต้อง");
		expect(validateRuleMatchValue("regex", "^(จอง|ยกเลิก)\\s*\\d+$")).toBeUndefined();
		expect(RULE_MATCH_GUIDES.regex.help).toContain("512");
	});

	test("gives real-time feedback for every match type", () => {
		expect(ruleMatchFeedback("equals", "จอง 14")).toEqual({
			valid: true,
			message: "รูปแบบถูกต้อง — บอทจะตอบเมื่อข้อความตรงกับ “จอง 14” ทุกตัวอักษร",
		});
		expect(ruleMatchFeedback("startsWith", "จอง")?.valid).toBe(true);
		expect(ruleMatchFeedback("containsAny", "14,,15")?.valid).toBe(false);
		expect(ruleMatchFeedback("containsAny", "14,15,car")?.message).toContain("3 คีย์");
		expect(ruleMatchFeedback("regex", "([unclosed")?.valid).toBe(false);
		expect(ruleMatchFeedback("regex", "^จอง\\d+$")?.valid).toBe(true);
		expect(ruleMatchFeedback("equals", "")).toBeUndefined();
	});
});
