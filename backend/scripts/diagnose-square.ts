/**
 * Prints the interference log from the terminal.
 *
 * Same rows the dashboard's "การรบกวน" tab shows — kept as a script so a
 * bot that is misbehaving can be looked at without a browser, and so the
 * evidence can be pasted into a conversation.
 *
 *   bun run scripts/diagnose-square.ts [botId]
 */
import { Database } from "bun:sqlite";

const botId = process.argv[2] ? Number(process.argv[2]) : undefined;
const db = new Database("data/app.db", { readonly: true });

const KIND_LABELS: Record<string, string> = {
	reply_destroyed: "ข้อความถูกลบ",
	reply_resent: "ส่งซ้ำแล้ว",
	reply_invisible: "ส่งแล้วแต่ไม่อยู่ในห้อง",
	send_rejected: "LINE ปฏิเสธข้อความ",
	send_dropped: "ลิมิตเราเองบล็อก",
	send_failed: "ส่งไม่สำเร็จ",
	duplicate_incoming: "ข้อความเข้าซ้ำ",
	members_unreadable: "อ่านสมาชิกห้องไม่ได้",
	listener_stopped: "สตรีมรับข้อความหยุด",
};

function stamp(ts: number): string {
	return new Date(ts).toISOString().replace("T", " ").slice(0, 23);
}

const chatNames = new Map<string, string>();
for (const chat of db.query<{ mid: string; name: string | null }, []>("SELECT mid, name FROM chats").all()) {
	if (chat.name) chatNames.set(chat.mid, chat.name);
}
const room = (mid: string | null): string => (mid ? (chatNames.get(mid) ?? mid.slice(0, 10) + "…") : "-");

const scope = botId === undefined ? "" : ` WHERE bot_id = ${botId}`;
const anomalies = db
	.query<{ bot_id: number | null; ts: number; kind: string; severity: string; chat_mid: string | null; detail: string | null }, []>(
		`SELECT bot_id, ts, kind, severity, chat_mid, detail FROM anomalies${scope} ORDER BY ts DESC LIMIT 80`,
	)
	.all();

console.log(`\n=== การรบกวน (ใหม่สุดล่างสุด) ${botId === undefined ? "· ทุกบอท" : `· bot ${botId}`} ===`);
if (anomalies.length === 0) {
	console.log("ไม่พบการรบกวน — ทุกการตอบผ่านตามปกติ (หรือยังไม่ได้รีสตาร์ท backend หลังอัปเดต)");
}
for (const row of anomalies.reverse()) {
	const label = KIND_LABELS[row.kind] ?? row.kind;
	console.log(`${stamp(row.ts)}  bot ${row.bot_id}  [${row.severity}] ${label}  ห้อง ${room(row.chat_mid)}  ${row.detail ?? ""}`);
}

const sends = db
	.query<{ bot_id: number; ts: number; target_mid: string; latency_ms: number; ok: number; source: string; text_preview: string }, []>(
		`SELECT bot_id, ts, target_mid, latency_ms, ok, source, text_preview FROM latency_samples
		 WHERE surface = 'square'${botId === undefined ? "" : ` AND bot_id = ${botId}`}
		 ORDER BY ts DESC LIMIT 15`,
	)
	.all();

console.log("\n=== การส่งข้อความล่าสุดใน OpenChat ===");
for (const send of sends.reverse()) {
	console.log(
		`${stamp(send.ts)}  bot ${send.bot_id}  ${room(send.target_mid)}  ${send.latency_ms.toFixed(0)}ms  ok=${send.ok}  ${send.source}  ${JSON.stringify(send.text_preview)}`,
	);
}

console.log(`
=== อ่านผลยังไง ===
reply_invisible     → ส่งสำเร็จแต่ห้องไม่มีข้อความ = โดนกรองเงียบๆ ส่งซ้ำไม่ช่วย ต้องเปลี่ยนบัญชีบอท
send_rejected       → LINE ตอบสถานะไม่ใช่ SENT = บัญชีถูกจำกัดสิทธิ์ในห้องนั้น
reply_destroyed     → โดนลบจริง ดูว่ามี reply_resent ตามมาไหม (ระบบส่งซ้ำให้เอง)
send_dropped        → ลิมิตของเราเองบล็อก ถ้าเจอถี่แปลว่าโดนยิงรัวจนเราเงียบเอง — ปรับ SEND_MIN_INTERVAL_MS
listener_stopped    → บอทหยุดได้ยินข้อความ กำลังต่อใหม่
ไม่มีอะไรเลย        → ไม่มีการรบกวนที่ระบบตรวจจับได้ในช่วงนั้น
`);
