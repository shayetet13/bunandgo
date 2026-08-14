/**
 * Copies one bot's keyword rules and admin-only setup to another bot of the
 * same owner, for the case a new bot joins a room another already covers —
 * so the room's triggers do not have to be retyped by hand.
 *
 * Rules are bot-wide, not per-room (see rules.ts), so this copies the whole
 * rule set; admin-only and its allowlist are per-room and copy for just the
 * one mid given.
 */
import { getBot } from "./bots.ts";
import { createRule, listRules, type Rule } from "./rules.ts";
import {
	isChatAdminOnly,
	listChatAdminAllowlist,
	setChatAdminAllowlist,
	setChatAdminOnly,
} from "./chat-access.ts";

export interface CopyRulesResult {
	rulesCopied: number;
	rulesSkipped: number;
}

export interface CopyRoomConfigResult extends CopyRulesResult {
	adminOnlyCopied: boolean;
}

function sameRule(a: Pick<Rule, "surface" | "matchType" | "matchValue">, b: Pick<Rule, "surface" | "matchType" | "matchValue">): boolean {
	return a.surface === b.surface && a.matchType === b.matchType && a.matchValue === b.matchValue;
}

/**
 * Refuses across different owners for the same reason `copyRoomConfig`
 * does — see its comment. Shared by the manual per-room copy and the
 * automatic copy a freshly created sibling bot gets.
 */
export function copyRules(fromBotId: number, toBotId: number): CopyRulesResult | undefined {
	const fromOwner = getBot(fromBotId)?.ownerUserId;
	const toOwner = getBot(toBotId)?.ownerUserId;
	if (fromOwner === null || fromOwner === undefined || fromOwner !== toOwner) return undefined;

	const existing = listRules(toBotId);
	let rulesCopied = 0;
	let rulesSkipped = 0;
	for (const rule of listRules(fromBotId)) {
		if (existing.some((row) => sameRule(row, rule))) {
			rulesSkipped++;
			continue;
		}
		createRule(toBotId, {
			surface: rule.surface,
			matchType: rule.matchType,
			matchValue: rule.matchValue,
			replyText: rule.replyText,
			enabled: rule.enabled,
			priority: rule.priority,
		});
		rulesCopied++;
	}
	return { rulesCopied, rulesSkipped };
}

/**
 * Refuses across different owners — copying a rule set between two
 * customers' bots would leak one operation's keyword playbook into
 * another's. Refuses an unowned bot on either side for the same reason:
 * there is no owner to scope the copy to.
 */
export function copyRoomConfig(fromBotId: number, toBotId: number, mid: string): CopyRoomConfigResult | undefined {
	const rules = copyRules(fromBotId, toBotId);
	if (!rules) return undefined;

	// `setChatAdminOnly` returns false when the target bot has no `chats`
	// row for `mid` yet — it must already be a member (see chat-access.ts) —
	// which folds "not applicable" and "not joined yet" into one false here.
	const adminOnlyCopied = isChatAdminOnly(fromBotId, mid) && setChatAdminOnly(toBotId, mid, true);
	if (adminOnlyCopied) setChatAdminAllowlist(toBotId, mid, listChatAdminAllowlist(fromBotId, mid));

	return { ...rules, adminOnlyCopied };
}
