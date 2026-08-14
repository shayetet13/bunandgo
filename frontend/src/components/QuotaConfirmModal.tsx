import type { QuotaPreview } from "../lib/types.ts";

/**
 * Confirms a bot quota change before it applies.
 *
 * The control behind this is a dropdown, which commits the instant it is
 * released — on a setting the customer is billed for and which, when it goes
 * down, switches their bots off. A dropdown is the wrong shape for that on
 * its own, so nothing is sent until this is accepted.
 *
 * Lowering names the bots it will stop rather than counting them: "ปิด 4 ตัว"
 * and "ปิด งาน3, งาน4, งาน5, งาน6" are very different things to click OK on,
 * and only the second lets the admin notice they picked the wrong row.
 */
interface QuotaConfirmModalProps {
	username: string;
	preview: QuotaPreview;
	pricePerMonthThb: number;
	busy: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}

export function QuotaConfirmModal({
	username,
	preview,
	pricePerMonthThb,
	busy,
	onConfirm,
	onCancel,
}: QuotaConfirmModalProps) {
	const raising = preview.nextQuota > preview.currentQuota;
	const delta = Math.abs(preview.nextQuota - preview.currentQuota);
	const stopping = preview.willStop.length;

	return (
		<div className="quota-modal-backdrop" onClick={busy ? undefined : onCancel}>
			<div className="panel quota-modal" onClick={(event) => event.stopPropagation()}>
				<div className="label" style={{ color: raising ? "var(--signal-go)" : "var(--signal-stop, #ff5365)" }}>
					{raising ? "เพิ่มโควตาบอท" : "ลดโควตาบอท"}
				</div>
				<h2 className="quota-modal-title">
					{username} · {preview.currentQuota} → {preview.nextQuota} ตัว
				</h2>

				{raising ? (
					<p className="quota-modal-line">
						เพิ่มขึ้น <strong>{delta} ตัว</strong> — คิดค่าบริการ{" "}
						<strong>{delta * pricePerMonthThb} บาท/เดือน</strong> เพิ่มจากเดิม
						<br />
						<span className="quota-modal-dim">
							({pricePerMonthThb} บาท/เดือน ต่อบอท 1 ตัว) ผู้ใช้จะสร้างบอทเพิ่มเองได้ทันที
						</span>
					</p>
				) : (
					<p className="quota-modal-line">
						ลดลง <strong>{delta} ตัว</strong> — ค่าบริการลดลง{" "}
						<strong>{delta * pricePerMonthThb} บาท/เดือน</strong>
					</p>
				)}

				{stopping > 0 && (
					<div className="quota-modal-warn">
						<div className="quota-modal-warn-head">
							⚠ บอท {stopping} ตัวนี้จะถูกปิดทันที
						</div>
						<ul className="quota-modal-list">
							{preview.willStop.map((bot) => (
								<li key={bot.id}>
									<strong>{bot.name}</strong>
									<span className="quota-modal-dim">
										{bot.status === "offline" ? " · ปิดอยู่แล้ว" : " · กำลังทำงานอยู่ จะถูกตัดการเชื่อมต่อ"}
									</span>
								</li>
							))}
						</ul>
						<p className="quota-modal-line quota-modal-dim" style={{ margin: 0 }}>
							ไม่ได้ลบทิ้ง — ข้อมูล กฎ และเซสชัน LINE ยังอยู่ครบ
							ถ้าเพิ่มโควตากลับ บอทจะเปิดใช้ได้เหมือนเดิมโดยไม่ต้องสแกน QR ใหม่
						</p>
					</div>
				)}

				{!raising && stopping === 0 && (
					<p className="quota-modal-line quota-modal-dim">
						ผู้ใช้มีบอท {preview.botCount} ตัว ยังไม่เกินโควตาใหม่ — ไม่มีบอทตัวไหนถูกปิด
					</p>
				)}

				<div className="quota-modal-actions">
					<button className="ghost-button" onClick={onCancel} disabled={busy}>ยกเลิก</button>
					<button
						className={stopping > 0 ? "danger-button" : "primary-button"}
						onClick={onConfirm}
						disabled={busy}
					>
						{busy ? "กำลังบันทึก…" : stopping > 0 ? `ยืนยัน — ปิดบอท ${stopping} ตัว` : "ยืนยัน"}
					</button>
				</div>
			</div>
		</div>
	);
}
