import { useEffect, useState } from "react";
import QRCode from "qrcode";

interface StartConfirmPanelProps {
	botName: string;
	confirmUrl: string;
}

/**
 * Decoy QR shown before the real LINE login QR — scanning it opens our own
 * confirm page (ban-risk warnings + ตกลง/ยกเลิก). Only once accepted there
 * does the real LINE QR appear in QrPanel. See start-confirmation.ts.
 */
export function StartConfirmPanel({ botName, confirmUrl }: StartConfirmPanelProps) {
	const [dataUrl, setDataUrl] = useState<string>();

	useEffect(() => {
		QRCode.toDataURL(confirmUrl, { margin: 1, width: 220, color: { dark: "#ffe19b", light: "#00000000" } })
			.then(setDataUrl)
			.catch(() => setDataUrl(undefined));
	}, [confirmUrl]);

	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				gap: "var(--space-sm)",
				padding: "var(--space-md)",
				background: "var(--bg-inset)",
				border: "1px solid var(--signal-warn-dim)",
				borderRadius: "var(--radius-md)",
				textAlign: "center",
			}}
		>
			<div className="label" style={{ color: "var(--signal-warn)" }}>
				ขั้นตอนที่ 1 · ยืนยันก่อนเริ่ม "{botName}"
			</div>
			<p className="hint" style={{ margin: 0 }}>
				สแกน QR นี้ด้วยกล้องมือถือ (ยังไม่ใช่ QR ของ LINE) เพื่ออ่านคำเตือนและยืนยันก่อนเริ่มเชื่อมต่อจริง
			</p>

			{dataUrl ? (
				<img
					src={dataUrl}
					width={180}
					height={180}
					alt="QR สำหรับยืนยันก่อนเริ่มบอท"
					style={{ display: "block", borderRadius: "var(--radius-sm)" }}
				/>
			) : (
				<div
					style={{
						width: 180,
						height: 180,
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						color: "var(--text-dim)",
						fontSize: "var(--text-sm)",
					}}
				>
					กำลังสร้าง QR…
				</div>
			)}

			<p className="hint" style={{ margin: 0 }}>
				หลังกด "ตกลง" ในหน้าที่เปิดขึ้น ให้กลับมาที่นี่เพื่อสแกน QR ของ LINE จริงต่อ
			</p>
		</div>
	);
}
