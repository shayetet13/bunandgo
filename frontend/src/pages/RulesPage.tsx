import type { Bot, ChatRow, Rule, ScheduledPost, UserRole } from "../lib/types.ts";
import { RuleEditor } from "../components/RuleEditor.tsx";
import { ChatList } from "../components/ChatList.tsx";
import { TestSendPanel } from "../components/TestSendPanel.tsx";
import { ScheduledPostEditor } from "../components/ScheduledPostEditor.tsx";
import { groupBotsByOwner } from "../lib/group-bots.ts";
import { useOwnerNames } from "../lib/useOwnerNames.ts";

interface RulesPageProps {
	bots: Bot[];
	role: UserRole;
	selectedBotId?: number;
	onSelectBotId: (botId: number) => void;
	onToggleOwnerTesting: (bot: Bot) => void;
	rules: Rule[];
	onCreate: (input: Omit<Rule, "id" | "botId">) => void;
	onToggle: (rule: Rule) => void;
	onUpdate: (rule: Rule) => void;
	onDelete: (id: number) => void;
	chats: ChatRow[];
	selectedMids: string[];
	onSelectMids: (mids: string[]) => void;
	onToggleChatEnabled: (chat: ChatRow) => void;
	onToggleChatAdminOnly: (chat: ChatRow) => void;
	scheduledPosts: ScheduledPost[];
	onCreateScheduledPost: (input: Omit<ScheduledPost, "id" | "botId" | "sentAt">) => void;
	onUpdateScheduledPost: (post: ScheduledPost) => void;
	onToggleScheduledPost: (post: ScheduledPost) => void;
	onDeleteScheduledPost: (id: number) => void;
}

const selectStyle = {
	background: "var(--bg-inset)",
	border: "1px solid var(--border-hair)",
	borderRadius: "var(--radius-sm)",
	padding: "0.5rem 0.75rem",
	color: "var(--text-primary)",
	fontSize: "var(--text-sm)",
};

export function RulesPage({
	bots,
	role,
	selectedBotId,
	onSelectBotId,
	onToggleOwnerTesting,
	rules,
	onCreate,
	onToggle,
	onUpdate,
	onDelete,
	chats,
	selectedMids,
	onSelectMids,
	onToggleChatEnabled,
	onToggleChatAdminOnly,
	scheduledPosts,
	onCreateScheduledPost,
	onUpdateScheduledPost,
	onToggleScheduledPost,
	onDeleteScheduledPost,
}: RulesPageProps) {
	const selectedBot = bots.find((b) => b.id === selectedBotId);
	const ownerNames = useOwnerNames(role);
	const groups = groupBotsByOwner(bots);
	const selectedGroup = groups.find((group) => group.bots.some((bot) => bot.id === selectedBotId));
	const hasSiblings = (selectedGroup?.bots.length ?? 0) > 1;

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: "var(--space-md)" }}>
			<section
				className="panel responsive-toolbar"
				style={{ padding: "var(--space-md)", display: "flex", alignItems: "center", gap: "var(--space-sm)" }}
			>
				<label className="label">เลือกบอท</label>
				<select value={selectedBotId ?? ""} onChange={(e) => onSelectBotId(Number(e.target.value))} style={selectStyle}>
					<option value="" disabled>
						— เลือกบอท —
					</option>
					{groups.map((group) =>
						group.bots.length > 1 ? (
							<optgroup
								key={group.key}
								label={group.ownerUserId === null ? "" : (ownerNames[group.ownerUserId] ?? `ผู้ใช้ #${group.ownerUserId}`)}
							>
								{group.bots.map((bot) => (
									<option key={bot.id} value={bot.id}>
										{bot.name}
									</option>
								))}
							</optgroup>
						) : (
							group.bots.map((bot) => (
								<option key={bot.id} value={bot.id}>
									{bot.name}
								</option>
							))
						),
					)}
				</select>
			</section>

			{!selectedBot ? (
				<section
					className="panel"
					style={{ padding: "var(--space-lg)", textAlign: "center", color: "var(--text-secondary)", fontSize: "var(--text-sm)" }}
				>
					เลือกบอทด้านบนเพื่อจัดการกฎการตอบและทดสอบส่งข้อความ
				</section>
			) : (
				<>
					<section
						className="panel responsive-toolbar"
						style={{
							padding: "var(--space-md)",
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							gap: "var(--space-md)",
						}}
					>
						<div>
							<div className="label" style={{ marginBottom: "var(--space-xs)" }}>
								กฎพิเศษ · ทดสอบโดยเจ้าของบัญชี
							</div>
							<p className="hint" style={{ margin: 0 }}>
								เปิดเพื่อให้บัญชี LINE ที่สแกน QR (ตัวบอทเอง) พิมพ์ข้อความแล้วทริกเกอร์กฎได้เหมือนลูกค้าจริง —
								ปกติบอทจะไม่ตอบข้อความของตัวเอง ต้องเปิดสวิตช์นี้ก่อนถึงจะทดสอบด้วยบัญชีนี้ได้ (ลูกค้าจริงคนอื่นในห้องที่ "ตอบอัตโนมัติ"
								เปิดไว้ด้านล่างจะได้รับคำตอบตามปกติอยู่แล้ว ไม่ต้องเปิดสวิตช์นี้)
							</p>
						</div>
						<button
							onClick={() => onToggleOwnerTesting(selectedBot)}
							style={{
								border: `1px solid ${selectedBot.allowOwnerTesting ? "var(--signal-go-dim)" : "var(--border-strong)"}`,
								color: selectedBot.allowOwnerTesting ? "var(--signal-go)" : "var(--text-secondary)",
								background: selectedBot.allowOwnerTesting ? "transparent" : "var(--bg-panel-raised)",
								borderRadius: "var(--radius-sm)",
								fontSize: "var(--text-xs)",
								fontWeight: 700,
								padding: "0.35rem 0.7rem",
								cursor: "pointer",
								whiteSpace: "nowrap",
							}}
						>
							{selectedBot.allowOwnerTesting ? "● ปิดการทดสอบ" : "○ เปิดการทดสอบ"}
						</button>
					</section>

					<RuleEditor rules={rules} onCreate={onCreate} onToggle={onToggle} onUpdate={onUpdate} onDelete={onDelete} />

					{selectedBot.status === "online" ? (
						<>
							<ChatList
								botId={selectedBot.id}
								chats={chats}
								selectedMids={selectedMids}
								onSelect={onSelectMids}
								onToggleEnabled={onToggleChatEnabled}
								onToggleAdminOnly={onToggleChatAdminOnly}
								hasSiblings={hasSiblings}
							/>
							<TestSendPanel botId={selectedBot.id} selectedChats={chats.filter((c) => selectedMids.includes(c.mid))} />
							<ScheduledPostEditor
								chats={chats}
								posts={scheduledPosts}
								onCreate={onCreateScheduledPost}
								onUpdate={onUpdateScheduledPost}
								onToggle={onToggleScheduledPost}
								onDelete={onDeleteScheduledPost}
							/>
						</>
					) : (
						<section
							className="panel"
							style={{ padding: "var(--space-lg)", textAlign: "center", color: "var(--text-secondary)", fontSize: "var(--text-sm)" }}
						>
							ต้องเข้าสู่ระบบสำเร็จก่อนจึงจะดูห้องแชทและทดสอบส่งข้อความได้ — ไปที่ "บอททั้งหมด" แล้วกด "เริ่ม"
						</section>
					)}
				</>
			)}
		</div>
	);
}
