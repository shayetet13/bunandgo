import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { LoginPhase } from "../lib/types.ts";
import { LinePinConfirm } from "./LinePinConfirm.tsx";

interface QrPanelProps {
	botName: string;
	qrUrl?: string;
	pincode?: string;
	phase?: LoginPhase;
	/** Lets the PIN screen's "ยกเลิก" abort the login the same way stopping the bot elsewhere does. */
	onCancel?: () => void;
}

const panelStyle = {
	display: "flex",
	flexDirection: "column",
	alignItems: "center",
	gap: "var(--space-sm)",
	padding: "var(--space-md)",
	background: "var(--bg-inset)",
	border: "1px solid var(--signal-go-dim)",
	borderRadius: "var(--radius-md)",
	textAlign: "center",
} as const;

/** Inline QR — embedded in the bot-creation flow, not a full-page gate. */
export function QrPanel({ botName, qrUrl, pincode, phase, onCancel }: QrPanelProps) {
	const [dataUrl, setDataUrl] = useState<string>();

	useEffect(() => {
		if (!qrUrl) {
			setDataUrl(undefined);
			return;
		}
		QRCode.toDataURL(qrUrl, { margin: 1, width: 220, color: { dark: "#e8ecf2", light: "#00000000" } })
			.then(setDataUrl)
			.catch(() => setDataUrl(undefined));
	}, [qrUrl]);

	// LINE spends the QR the instant it accepts the scan, but the bot stays
	// "connecting" for the seconds it takes to build the session afterwards.
	// Keeping a login prompt on screen through that window reads as "the scan
	// did nothing" and invites a second scan of a code that is already dead.
	if (phase === "preparing") {
		return (
			<div style={panelStyle}>
				<div className="label" style={{ color: "var(--signal-go)" }}>เชื่อมต่อ LINE สำเร็จแล้ว</div>
				<p className="hint" style={{ margin: 0 }}>
					กำลังเตรียมบอท "{botName}" ให้พร้อมตอบ — ใช้เวลาสักครู่ ไม่ต้องสแกนซ้ำ
				</p>
			</div>
		);
	}

	// No QR exists yet: the stored session is being tried first, and it may
	// succeed without ever needing one. Saying so beats an empty QR frame.
	if (phase === "resuming" || (!qrUrl && !pincode && phase === undefined)) {
		return (
			<div style={panelStyle}>
				<div className="label" style={{ color: "var(--signal-warn)" }}>กำลังเชื่อมต่อ LINE</div>
				<p className="hint" style={{ margin: 0 }}>
					กำลังกู้คืนเซสชันเดิมของบอท "{botName}" — ถ้าใช้ไม่ได้ ระบบจะแสดง QR ให้สแกนโดยอัตโนมัติ
				</p>
			</div>
		);
	}

	// By the time LINE issues a PIN the QR has already been scanned and spent
	// (see LinePinConfirm's doc comment) — this replaces the QR view entirely
	// rather than appending the PIN below a code that no longer does anything.
	if (pincode) {
		return <LinePinConfirm pincode={pincode} onCancel={onCancel} />;
	}

	return (
		<div style={panelStyle}>
			<div className="label" style={{ color: "var(--signal-go)" }}>สแกนเพื่อเชื่อมต่อบอท "{botName}"</div>
			<p className="hint" style={{ margin: 0 }}>เปิดแอป LINE แล้วสแกน QR นี้เพื่อผูกบัญชี</p>

			{dataUrl ? (
				<img src={dataUrl} width={180} height={180} alt="QR สำหรับเข้าสู่ระบบ LINE" style={{ display: "block", borderRadius: "var(--radius-sm)" }} />
			) : (
				<div style={{ width: 180, height: 180, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: "var(--text-sm)" }}>
					กำลังสร้าง QR โค้ด…
				</div>
			)}
		</div>
	);
}
