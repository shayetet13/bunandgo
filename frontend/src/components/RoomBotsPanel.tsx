import { useState } from "react";
import { api } from "../lib/api.ts";
import type { BotStatus, RoomBotInfo } from "../lib/types.ts";

/**
 * OpenChat-only: shows every one of this bot's owner's other bots also
 * sitting in this room (including offline ones — see primary-bot.ts) and
 * lets the owner hand off which one actually answers.
 *
 * Fetched on demand only — the room-bots round trip runs once per click,
 * never on page load, so a page listing many rooms never fans out a request
 * per card. Read-only until "ตั้งหลัก" is pressed, and even that only
 * touches the `chats.is_primary` column — nothing here is on the reply
 * hot path (session-manager.ts already re-checks online status itself
 * before ever using this flag).
 */
interface RoomBotsPanelProps {
	botId: number;
	mid: string;
}

const STATUS_LABEL: Record<BotStatus, string> = {
	offline: "ออฟไลน์",
	connecting: "กำลังเชื่อมต่อ",
	online: "ออนไลน์",
};

const STATUS_COLOR: Record<BotStatus, string> = {
	offline: "var(--signal-idle)",
	connecting: "var(--signal-warn)",
	online: "var(--signal-go)",
};

export function RoomBotsPanel({ botId, mid }: RoomBotsPanelProps) {
	const [open, setOpen] = useState(false);
	const [bots, setBots] = useState<RoomBotInfo[]>();
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string>();
	const [settingPrimaryId, setSettingPrimaryId] = useState<number>();

	async function load() {
		setLoading(true);
		setError(undefined);
		try {
			setBots(await api.listRoomBots(botId, mid));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}

	function toggle() {
		const next = !open;
		setOpen(next);
		if (next && bots === undefined) void load();
	}

	async function makePrimary(targetBotId: number) {
		setSettingPrimaryId(targetBotId);
		setError(undefined);
		try {
			await api.setPrimaryBot(targetBotId, mid);
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSettingPrimaryId(undefined);
		}
	}

	// A room with no siblings has nothing to hand off — hide the control
	// entirely rather than a button that only ever opens to "just you".
	if (bots !== undefined && bots.length <= 1) return null;

	return (
		<div onClick={(event) => event.stopPropagation()} style={{ width: "100%" }}>
			<button
				type="button"
				className="uc-btn uc-btn--sm uc-btn--ghost"
				onClick={toggle}
				style={{ fontSize: "0.6875rem", padding: "0.15rem 0.5rem" }}
			>
				{open ? "ซ่อนบอทพี่น้อง" : "บอทพี่น้องในห้องนี้"}
			</button>
			{open && (
				<div style={{ display: "flex", flexDirection: "column", gap: "0.3rem", marginTop: "0.35rem" }}>
					{loading && <p className="admin-only-hint">กำลังโหลด…</p>}
					{error && (
						<p className="admin-only-hint" style={{ color: "var(--signal-bad)" }}>
							{error}
						</p>
					)}
					{bots?.map((bot) => (
						<div key={bot.botId} style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.6875rem" }}>
							<span
								aria-hidden="true"
								style={{ width: 6, height: 6, borderRadius: "50%", background: STATUS_COLOR[bot.status], flexShrink: 0 }}
							/>
							<span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
								{bot.name ?? `bot${bot.slot ?? bot.botId}`}
								{bot.botId === botId ? " (ตัวนี้)" : ""}
							</span>
							<span style={{ color: "var(--text-dim)" }}>{STATUS_LABEL[bot.status]}</span>
							{bot.isPrimary ? (
								<span className="chip chip--go" style={{ fontSize: "0.625rem" }}>
									หลัก
								</span>
							) : (
								<button
									type="button"
									className="uc-btn uc-btn--sm uc-btn--ghost"
									disabled={bot.status !== "online" || settingPrimaryId !== undefined}
									title={bot.status !== "online" ? "ต้องออนไลน์ก่อนจึงจะตั้งเป็นบอทหลักได้" : undefined}
									onClick={() => void makePrimary(bot.botId)}
									style={{ fontSize: "0.625rem", padding: "0.1rem 0.4rem" }}
								>
									{settingPrimaryId === bot.botId ? "…" : "ตั้งหลัก"}
								</button>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
