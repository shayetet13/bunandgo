import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import type { ChatRow, SquareMemberInfo } from "../lib/types.ts";
import { ToggleSwitch } from "./ToggleSwitch.tsx";

/**
 * The "ตอบเฉพาะ admin" switch plus, once it is on, the list of admins to
 * narrow it to.
 *
 * Shared by the admin dashboard's ChatList and the user console so the two
 * cannot drift into offering different controls for the same setting.
 *
 * Choosing nobody means every admin — that is the setting's own meaning
 * without an allowlist, and the alternative reading ("answer no one") is a
 * room that goes silent while every indicator still says it is working.
 * The copy below says so rather than leaving it to be discovered.
 */
interface AdminOnlyControlProps {
	botId: number;
	chat: ChatRow;
	onToggleAdminOnly: (chat: ChatRow) => void;
	onError?: (message: string) => void;
}

export function AdminOnlyControl({ botId, chat, onToggleAdminOnly, onError }: AdminOnlyControlProps) {
	const [admins, setAdmins] = useState<SquareMemberInfo[]>();
	const [selected, setSelected] = useState<string[]>([]);
	const [saving, setSaving] = useState(false);

	const adminOnly = !!chat.admin_only;

	// Only fetched once the switch is on: the member list is a per-room round
	// trip, and a page listing twenty rooms should not make twenty of them for
	// a control nobody has opened.
	useEffect(() => {
		if (!adminOnly) return;
		let cancelled = false;
		void Promise.all([
			api.listSquareMembers(botId, chat.mid).catch(() => [] as SquareMemberInfo[]),
			api.getChatAdminAllowlist(botId, chat.mid).catch(() => ({ memberMids: [], rolesResolved: false })),
		]).then(([members, allowlist]) => {
			if (cancelled) return;
			setAdmins(members.filter((member) => isAdminRole(member.role)));
			setSelected(allowlist.memberMids);
		});
		return () => {
			cancelled = true;
		};
	}, [botId, chat.mid, adminOnly]);

	async function save(memberMids: string[]) {
		const previous = selected;
		setSelected(memberMids);
		setSaving(true);
		try {
			await api.setChatAdminAllowlist(botId, chat.mid, memberMids);
		} catch (error) {
			setSelected(previous);
			onError?.(error instanceof Error ? error.message : String(error));
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="admin-only-control" onClick={(event) => event.stopPropagation()}>
			<div className="admin-only-switch">
				<span className={adminOnly ? "admin-only-label is-on" : "admin-only-label"}>ตอบเฉพาะ admin</span>
				<ToggleSwitch isSelected={adminOnly} onToggle={() => onToggleAdminOnly(chat)} />
			</div>

			{adminOnly && (
				<div className="admin-only-picker">
					{admins === undefined ? (
						<p className="admin-only-hint">กำลังโหลดรายชื่อ admin…</p>
					) : admins.length === 0 ? (
						// The roles cache is rebuilt on connect and lives in memory
						// only, so an offline bot genuinely has no names to offer.
						// Saying which of the two it is saves a support round trip.
						<p className="admin-only-hint">
							ยังไม่ทราบรายชื่อ admin ในห้องนี้ — บอทต้องออนไลน์อยู่จึงจะดึงรายชื่อได้ ระหว่างนี้บอทจะตอบ admin ทุกคน
						</p>
					) : (
						<>
							<p className="admin-only-hint">
								{selected.length === 0
									? "ตอบ admin ทุกคนในห้อง — เลือกรายชื่อเพื่อจำกัดให้แคบลง"
									: `ตอบเฉพาะ ${selected.length} คนที่เลือกไว้`}
							</p>
							<div className="admin-only-names">
								{admins.map((admin) => {
									const checked = selected.includes(admin.mid);
									return (
										<label key={admin.mid} className={checked ? "admin-only-name is-on" : "admin-only-name"}>
											<input
												type="checkbox"
												checked={checked}
												disabled={saving}
												onChange={() => void save(
													checked
														? selected.filter((mid) => mid !== admin.mid)
														: [...selected, admin.mid],
												)}
											/>
											<span>{admin.displayName}</span>
										</label>
									);
								})}
							</div>
							{selected.length > 0 && (
								<button
									type="button"
									className="uc-btn uc-btn--sm uc-btn--ghost"
									disabled={saving}
									onClick={() => void save([])}
								>
									ล้างรายชื่อ (ตอบ admin ทุกคน)
								</button>
							)}
						</>
					)}
				</div>
			)}
		</div>
	);
}

/** Mirrors isAdminRole on the server — the wire value may be name or enum. */
function isAdminRole(role: SquareMemberInfo["role"]): boolean {
	return role === "ADMIN" || role === 1 || role === "CO_ADMIN" || role === 2;
}
