interface LinePinConfirmProps {
	pincode: string;
	/** Omitted where the caller has no independent way to abort the login (there always should be one, but this keeps the button from rendering broken). */
	onCancel?: () => void;
}

/**
 * Mirrors LINE's own "ยืนยันการเข้าสู่ระบบบน PC" screen almost verbatim — the
 * PIN step is the point in the flow closest to what a LINE user has actually
 * seen before (on the official desktop client), so matching its exact
 * copy/layout is what makes this read as "the real thing" instead of a
 * generic code-entry prompt.
 *
 * Replaces the QR entirely rather than sitting beside it: by the time LINE
 * issues a PIN, the QR scan has already been consumed (see requestSQR's
 * comment in linejs-core — verifyCertificate is attempted only after
 * checkQrCodeVerified succeeds), so a QR still on screen next to this is a
 * dead code inviting a pointless second scan.
 */
export function LinePinConfirm({ pincode, onCancel }: LinePinConfirmProps) {
	return (
		<div className="line-pin">
			<div className="line-pin-accent" aria-hidden="true" />
			<div className="line-pin-body">
				<h2 className="line-pin-title">ยืนยันการเข้าสู่ระบบบน PC</h2>
				<p className="line-pin-text">
					คุณต้องยืนยันด้วยตนเองเมื่อเข้าสู่ระบบ LINE เวอร์ชั่น PC เป็นครั้งแรกของทุกอุปกรณ์เพื่อความปลอดภัย
				</p>
				<p className="line-pin-text">โปรดใส่รหัสนี้บนสมาร์ทโฟน</p>

				<strong className="line-pin-code mono">{pincode}</strong>

				<p className="line-pin-help">
					หากคุณไม่สามารถใช้ LINE บนสมาร์ทโฟนได้ เราขอแนะนำให้คุณย้ายบัญชีไปยังอุปกรณ์เครื่องใหม่{" "}
					<span className="line-pin-link">โอนย้ายบัญชี LINE</span>
				</p>

				{onCancel && (
					<button type="button" className="line-pin-cancel" onClick={onCancel}>
						ยกเลิก
					</button>
				)}
			</div>
		</div>
	);
}
