import type { IdLockMismatchEvent } from "../lib/types.ts";

/**
 * Center-screen, hard-to-miss alert for a rejected login: a LINE account
 * other than the one first locked to this bot tried to scan its QR.
 *
 * Deliberately louder than the toast notifications elsewhere in this app —
 * `onNotify` alone is easy to miss mid-scan, and the operator needs to know
 * immediately that the session was refused rather than discover it later as
 * "the bot never came online."
 */
interface IdLockAlertModalProps {
	event: IdLockMismatchEvent;
	onDismiss: () => void;
}

export function IdLockAlertModal({ event, onDismiss }: IdLockAlertModalProps) {
	return (
		<div className="id-lock-modal-backdrop" onClick={onDismiss}>
			<div className="panel id-lock-modal" onClick={(e) => e.stopPropagation()}>
				<div className="id-lock-modal-icon" aria-hidden="true">!</div>
				<h2 className="id-lock-modal-title">เข้าสู่ระบบไม่สำเร็จ — บัญชี LINE ไม่ตรงกัน</h2>
				<p className="id-lock-modal-bot">
					บอท <strong>{event.botName}</strong>
				</p>
				<p className="id-lock-modal-line">
					บอทนี้ผูกไว้กับบัญชี LINE บัญชีแรกที่เคยเข้าสู่ระบบสำเร็จแล้ว
					จะใช้บัญชี LINE อื่นสแกน QR แทนไม่ได้ — ระบบจึงปฏิเสธการเข้าสู่ระบบนี้โดยอัตโนมัติ
					<br />
					หากต้องการเปลี่ยนบัญชี กรุณาติดต่อผู้ดูแลระบบ
				</p>
				<div className="id-lock-modal-actions">
					<button type="button" onClick={onDismiss}>เข้าใจแล้ว</button>
				</div>
			</div>
		</div>
	);
}
