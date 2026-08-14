interface HelpModalProps {
	onClose: () => void;
}

interface Section {
	title: string;
	body: string[];
}

const SECTIONS: Section[] = [
	{
		title: "1. บอท (Bots)",
		body: [
			"กดปุ่ม \"+ สร้างบอท\" แล้วตั้งชื่อ (ตั้งชื่อให้จำง่าย เช่น ชื่อกลุ่มหรือชื่อบัญชี) ระบบจะสร้างบอทและเริ่มเข้าสู่ระบบด้วย QR ให้ทันที — QR จะขึ้นอยู่ใต้ชื่อบอทนั้นเลย ใช้แอป LINE สแกนเพื่อผูกบัญชี",
			"สถานะบอทมี 3 แบบ: ออฟไลน์ (ยังไม่ได้เข้าสู่ระบบ) กำลังเชื่อมต่อ (รอสแกน QR) และ ออนไลน์ (พร้อมใช้งาน)",
			"แต่ละบอทคือบัญชี LINE คนละบัญชี แยกข้อมูลกันเด็ดขาด — กฎ, ห้องแชท, และ session ของแต่ละบอทไม่เกี่ยวข้องกันเลย",
			"คลิกที่ชื่อบอทในลิสต์เพื่อเลือกดู/จัดการบอทนั้น",
		],
	},
	{
		title: "2. กฎการตอบอัตโนมัติ (Race Rules)",
		body: [
			"กฎคือเงื่อนไขที่บอทใช้ตัดสินใจว่าจะตอบข้อความไหน และตอบว่าอะไร — เลือกได้ว่าจะใช้ทุกประเภท (all), แชทกลุ่ม (talk) หรือ OpenChat/OA (square)",
			"เปิดกฎพิเศษ \"ทดสอบโดยเจ้าของบัญชี\" เพื่อให้บัญชี LINE ที่ใช้สแกน QR พิมพ์ข้อความทดสอบกฎในกลุ่มหรือ OpenChat ได้เอง โดยระบบจะกันข้อความตอบของบอทไม่ให้วนซ้ำ",
			"รูปแบบการจับคู่ข้อความ: \"equals\" ต้องตรงทั้งหมด, \"startsWith\" แค่ขึ้นต้นตรงก็พอ, \"regex\" ใช้ regular expression สำหรับเงื่อนไขซับซ้อน",
			"เมื่อมีข้อความเข้ามาตรงกับกฎที่เปิดใช้งานอยู่ (ON) บอทจะตอบกลับทันทีด้วยข้อความที่ตั้งไว้ — เร็วที่สุดเท่าที่ระบบจะทำได้ ผ่าน Go dispatcher",
			"กดปุ่ม ON/OFF เพื่อเปิด-ปิดกฎ โดยไม่ต้องลบทิ้ง",
		],
	},
	{
		title: "3. ทดสอบส่งข้อความ (Test Send)",
		body: [
			"ใช้ทดลองยิงข้อความออกไปยังห้องแชทที่เลือกไว้ โดยไม่ต้องรอให้มีคนพิมพ์มาก่อน",
			"ผลลัพธ์การทดสอบจะถูกนับรวมในค่า P95 ด้านบนเหมือนการตอบจริงทุกประการ — ใช้เช็คความเร็วของระบบได้ตลอดเวลา",
		],
	},
	{
		title: "4. บันทึกสด (Live Feed)",
		body: [
			"แสดงข้อความที่เข้ามา (IN) และข้อความที่บอทส่งออกไป (OUT) แบบเรียลไทม์ เฉพาะของบอทที่กำลังเลือกอยู่",
			"แถวที่เป็น OUT จะโชว์เวลาที่ใช้ตอบ (มิลลิวินาที) พร้อมสีบอกสถานะ: เขียว = เร็ว, เหลือง = ปานกลาง, แดง = ช้าหรือผิดพลาด",
		],
	},
	{
		title: "5. ตัวเลข P95 / P50 / P99",
		body: [
			"เป็นค่าความหน่วง (latency) ของการส่งข้อความ วัดจากประวัติการส่งล่าสุด (สูงสุด 500 ครั้ง)",
			"P95 = เวลาที่ 95% ของการส่งทั้งหมดเร็วกว่าค่านี้ (ถ้ามีคนช้าบ้างนานๆ ครั้ง P95 จะไม่กระโดดตามง่ายๆ) — เป็นตัวเลขหลักที่ใช้วัดว่าบอท \"แย่งตอบไว\" แค่ไหน",
			"P50 คือค่ากลาง (median), P99 คือกรณีแย่ที่สุดที่พบบ่อย ตัวเลขนี้จะรวมทุกบอทเข้าด้วยกัน (ภาพรวมทั้งระบบ)",
		],
	},
	{
		title: "6. เข้าสู่ระบบ / ออกจากระบบ",
		body: [
			"หน้าเข้าสู่ระบบนี้ใช้ป้องกันไม่ให้คนอื่นเข้ามาควบคุมบอทของคุณได้ — เป็นคนละส่วนกับการสแกน QR ของแต่ละบอท",
			"เซสชันเข้าสู่ระบบจะอยู่ข้ามการรีสตาร์ท backend และต่ออายุเมื่อใช้งาน กด \"ออกจากระบบ\" มุมขวาบนเมื่อต้องการจบเซสชัน",
		],
	},
];

export function HelpModal({ onClose }: HelpModalProps) {
	return (
		<div
			onClick={onClose}
			style={{
				position: "fixed",
				inset: 0,
				background: "rgba(4, 5, 8, 0.72)",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				zIndex: 100,
				padding: "var(--space-lg)",
			}}
		>
			<div
				onClick={(e) => e.stopPropagation()}
				className="panel"
				style={{
					maxWidth: 680,
					width: "100%",
					maxHeight: "85vh",
					overflowY: "auto",
					padding: "var(--space-lg)",
					background: "var(--bg-panel-raised)",
				}}
			>
				<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--space-md)" }}>
					<h2 style={{ margin: 0, fontSize: "1.2rem", fontWeight: 800 }}>วิธีใช้งาน RACE Console</h2>
					<button
						onClick={onClose}
						style={{
							background: "transparent",
							border: "1px solid var(--border-strong)",
							color: "var(--text-secondary)",
							borderRadius: "var(--radius-sm)",
							padding: "0.3rem 0.7rem",
							cursor: "pointer",
							fontSize: "var(--text-sm)",
						}}
					>
						ปิด ✕
					</button>
				</div>

				<div style={{ display: "flex", flexDirection: "column", gap: "var(--space-md)" }}>
					{SECTIONS.map((section) => (
						<div key={section.title}>
							<h3 style={{ margin: "0 0 var(--space-xs)", fontSize: "1.05rem", color: "var(--signal-go)" }}>{section.title}</h3>
							<div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
								{section.body.map((line, i) => (
									<p key={i} className="hint" style={{ margin: 0 }}>{line}</p>
								))}
							</div>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
