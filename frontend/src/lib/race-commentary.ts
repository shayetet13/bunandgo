import type { LatencySample } from "./types.ts";

const RACE_TARGET_MS = 23;
const RACE_WINDOW = 10;

export type RaceTone = "idle" | "blitz" | "fast" | "late" | "failed";
type ActiveRaceTone = Exclude<RaceTone, "idle">;

export interface RaceCommentary {
	tone: RaceTone;
	headline: string;
	roast: string;
	achievement?: string;
	streakLabel: string;
	hits: number;
	total: number;
	hitRate: number;
	recent: RaceTone[];
	latest?: LatencySample;
}

const ROASTS: Record<ActiveRaceTone, readonly string[]> = {
	blitz: [
		"นี่บอทหรือเครื่องย้อนเวลา? คนอื่นยังหาปุ่มส่งไม่เจอเลย",
		"ไวแบบนี้คู่แข่งควรขอใบรับรองแพทย์แล้วนะ",
		"แซงแบบไม่เปิดไฟเลี้ยว สนามยังงงอยู่เลย",
	],
	fast: [
		"เข้าเป้าแบบหล่อ ๆ เหลือเวลาไว้เดินกลับมารับเหรียญด้วย",
		"งานเรียบร้อย คู่แข่งเชิญต่อคิวช่องถัดไปครับ",
		"ไวพอให้ยิ้มมุมปาก แต่อย่าเพิ่งเหลิง เดี๋ยวระบบได้ใจ",
	],
	late: [
		"ช้าไปหนึ่งลมหายใจ แต่ทำหน้าเนียนเหมือนตั้งใจไว้ก่อน",
		"ข้อความถึงแล้ว ส่วนความไวกำลังเรียกแท็กซี่ตามมา",
		"เกินเป้านิดเดียว สนามไม่ว่าอะไร แต่คนดูจำหมดแล้ว",
	],
	failed: ["ออกตัวแรงมาก เสียดายล้อไปคนละทาง", "รอบนี้ส่งไม่สำเร็จ ระบบขอทำเป็นไม่เคยรู้จักกัน", "บอทบอกพร้อมครับ… แล้วก็หายเข้ากลีบเมฆ"],
};

export function raceTone(sample: LatencySample): ActiveRaceTone {
	if (!sample.ok) return "failed";
	if (sample.latencyMs < 15) return "blitz";
	if (sample.latencyMs < RACE_TARGET_MS) return "fast";
	return "late";
}

function isTargetHit(tone: RaceTone): boolean {
	return tone === "blitz" || tone === "fast";
}

function deterministicRoast(tone: ActiveRaceTone, sample: LatencySample): string {
	const choices = ROASTS[tone];
	const seed = Math.abs((sample.ts | 0) ^ sample.botId);
	return choices[seed % choices.length]!;
}

function headlineFor(tone: RaceTone): string {
	if (tone === "blitz") return "เครื่องย้อนเวลาเปิดแล้ว ⚡";
	if (tone === "fast") return "เข้าเส้นชัยก่อนกาแฟจะเย็น 🏁";
	if (tone === "late") return "มาช้า แต่ยังทำหน้าเนียน 😏";
	if (tone === "failed") return "ออกตัวแล้วล้อหลุด 🛞";
	return "สนามยังเงียบผิดปกติ";
}

function achievementFor(tone: RaceTone, sample: LatencySample, streak: number): string | undefined {
	if (tone === "blitz") return "🏆 ปลดล็อก: ไวเกินมนุษย์";
	if (streak >= 5) return "🔥 ปลดล็อก: ตัวตึงประจำสนาม";
	if (streak >= 3) return "🔥 ปลดล็อก: เครื่องกำลังติด";
	if (tone === "late" && sample.latencyMs - RACE_TARGET_MS <= 1) return "🤏 ปลดล็อก: เส้นยาแดงผ่าแปด";
	if (tone === "failed") return "🧰 ปลดล็อก: ช่างกำลังมา";
	return undefined;
}

/**
 * Pure, client-side race theatre. It reads completed auto-reply samples only;
 * no polling, persistence, or work is added to the bot's send path.
 */
export function buildRaceCommentary(samples: LatencySample[]): RaceCommentary {
	const autoReplies = samples.filter((sample) => sample.source === "auto").slice(0, RACE_WINDOW);
	const latest = autoReplies[0];
	if (!latest) {
		return {
			tone: "idle",
			headline: headlineFor("idle"),
			roast: "รอคำตอบอัตโนมัติรอบแรกอยู่ คู่แข่งยังมีเวลาทำใจ",
			streakLabel: "ยังไม่มีสถิติให้โม้",
			hits: 0,
			total: 0,
			hitRate: 0,
			recent: [],
		};
	}

	const recent = autoReplies.map(raceTone);
	const latestHit = isTargetHit(recent[0]!);
	let streak = 0;
	for (const tone of recent) {
		if (isTargetHit(tone) !== latestHit) break;
		streak++;
	}
	const hits = recent.filter(isTargetHit).length;
	const tone = recent[0]!;

	return {
		tone,
		headline: headlineFor(tone),
		roast: deterministicRoast(tone, latest),
		achievement: achievementFor(tone, latest, latestHit ? streak : 0),
		streakLabel: latestHit ? `เข้าเป้าติดกัน ${streak} รอบ` : `พลาดเป้าติดกัน ${streak} รอบ — จะให้สนามลืมคงยาก`,
		hits,
		total: recent.length,
		hitRate: Math.round((hits / recent.length) * 100),
		recent,
		latest,
	};
}
