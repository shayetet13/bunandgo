import { useEffect, useState } from "react";
import type { Bot, UserRole } from "../lib/types.ts";
import { LiveFeed } from "../components/LiveFeed.tsx";
import type { FeedItem } from "../lib/types.ts";
import { groupBotsByOwner } from "../lib/group-bots.ts";
import { useOwnerNames } from "../lib/useOwnerNames.ts";
import { api } from "../lib/api.ts";

interface LiveFeedPageProps {
	bots: Bot[];
	role: UserRole;
	selectedGroupKey?: string;
	onSelectGroupKey: (key: string) => void;
	feed: FeedItem[];
}

const selectStyle = {
	background: "var(--bg-inset)",
	border: "1px solid var(--border-hair)",
	borderRadius: "var(--radius-sm)",
	padding: "0.5rem 0.75rem",
	color: "var(--text-primary)",
	fontSize: "var(--text-sm)",
};

export function LiveFeedPage({ bots, role, selectedGroupKey, onSelectGroupKey, feed }: LiveFeedPageProps) {
	const ownerNames = useOwnerNames(role);
	const groups = groupBotsByOwner(bots);
	const selectedGroup = groups.find((g) => g.key === selectedGroupKey);
	const botNameById = Object.fromEntries(bots.map((bot) => [bot.id, `bot${bot.slot} · ${bot.name}`]));

	// The feed only carries a room's mid, not its display name — chat names
	// live per-bot in the chats table, so every bot in the selected group
	// needs its own lookup fetched and merged into one mid -> name map.
	const [chatNameByMid, setChatNameByMid] = useState<Record<string, string>>({});
	useEffect(() => {
		if (!selectedGroup) {
			setChatNameByMid({});
			return;
		}
		let cancelled = false;
		Promise.all(selectedGroup.bots.map((bot) => api.listChats(bot.id).catch(() => [])))
			.then((chatLists) => {
				if (cancelled) return;
				const merged: Record<string, string> = {};
				for (const chats of chatLists) {
					for (const chat of chats) {
						if (chat.name) merged[chat.mid] = chat.name;
					}
				}
				setChatNameByMid(merged);
			});
		return () => {
			cancelled = true;
		};
	}, [selectedGroup?.key]);

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: "var(--space-md)", }}>
			<section className="panel responsive-toolbar" style={{ padding: "var(--space-md)", display: "flex", alignItems: "center", gap: "var(--space-sm)" }}>
				<label className="label">เลือกบอท</label>
				<select
					value={selectedGroupKey ?? ""}
					onChange={(e) => onSelectGroupKey(e.target.value)}
					style={selectStyle}
				>
					<option value="" disabled>— เลือกบอท —</option>
					{groups.map((group) => {
						const label = group.ownerUserId === null
							? group.bots[0]!.name
							: (ownerNames[group.ownerUserId] ?? `ผู้ใช้ #${group.ownerUserId}`) +
								(group.bots.length > 1 ? ` (${group.bots.length} บอท)` : "");
						return <option key={group.key} value={group.key}>{label}</option>;
					})}
				</select>
			</section>

			{selectedGroup === undefined || bots.length === 0 ? (
				<section className="panel" style={{ padding: "var(--space-lg)", textAlign: "center", color: "var(--text-secondary)", fontSize: "var(--text-sm)" }}>
					เลือกบอทด้านบนเพื่อดูบันทึกสด
				</section>
			) : (
				<div style={{ height: 560 }}>
					<LiveFeed items={feed} botNameById={botNameById} showBotTag={selectedGroup.bots.length > 1} chatNameByMid={chatNameByMid} />
				</div>
			)}
		</div>
	);
}
