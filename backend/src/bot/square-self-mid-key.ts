/**
 * Builds the cache key session-manager.ts uses to remember a bot's own
 * member mid inside an OpenChat.
 *
 * A square chat mid is only unique within one LINE account's view of it —
 * two different bot accounts (different tenants) can both be joined to the
 * same OpenChat, each with their own member mid there. The key must include
 * `botId` so two tenants sharing a chat can never collide; extracted to its
 * own module so that invariant is unit-testable without importing
 * session-manager.ts (which requires a live dispatch token and DB to load).
 *
 * Collision safety: every real `squareChatMid` starts with the literal
 * character `m` (see the `/^m[0-9a-f]{32}$/i` validation used elsewhere for
 * this mid shape), so the `:` separator plus that leading `m` means no
 * numeric `botId` prefix can ever be mistaken for a different, longer
 * `botId` prefix followed by a chat mid.
 */
export function squareSelfMidKey(botId: number, squareChatMid: string): string {
	return `${botId}:${squareChatMid}`;
}
