import { describe, expect, test } from "bun:test";
import { chatCategory, chatLabel } from "./chat-category.ts";
import type { Surface } from "./types.ts";

const chat = (surface: Surface, mid: string) => ({ surface, mid });

describe("chat category presentation", () => {
	test("splits peer and group MIDs that share the talk protocol", () => {
		expect(chatCategory(chat("talk", "u" + "1".repeat(32)))).toBe("direct");
		expect(chatLabel(chat("talk", "u" + "1".repeat(32)))).toBe("1:1 บุคคล");
		expect(chatCategory(chat("talk", "c" + "2".repeat(32)))).toBe("group");
		expect(chatLabel(chat("talk", "r" + "3".repeat(32)))).toBe("กลุ่ม LINE");
	});

	test("uses product-facing labels for OA and OpenChat", () => {
		expect(chatLabel(chat("oa", "u" + "4".repeat(32)))).toBe("LINE OA");
		expect(chatLabel(chat("square", "m" + "5".repeat(32)))).toBe("OP Talk");
	});
});
