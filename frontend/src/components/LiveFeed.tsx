import { useMemo, type CSSProperties } from "react";
import type { FeedItem } from "../lib/types.ts";
import { formatMs as ms } from "../lib/format-ms.ts";
import { BUDGET, measureAnswers, sumLatencyBreakdown, toneFor, toneForAnswer, type Budget } from "../lib/live-feed-metrics.ts";

function timeLabel(ts: number): string {
	const d = new Date(ts);
	return d.toLocaleTimeString(undefined, { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

interface LiveFeedProps {
	items: FeedItem[];
	/** Bot id -> display name, for the per-row tag when a feed spans more than one bot. */
	botNameById?: Record<number, string>;
	/** Only meaningful when true — a single-bot feed never shows the tag, matching today's look exactly. */
	showBotTag?: boolean;
}

export function LiveFeed({ items, botNameById, showBotTag }: LiveFeedProps) {
	// Dashboard refreshes its counters every five seconds. The feed itself may
	// not have changed, so avoid re-sorting up to 200 rows on those renders.
	const answerTimes = useMemo(() => measureAnswers(items), [items]);
	const newestFirstItems = useMemo(() => [...items].reverse(), [items]);
	return (
		<section className="panel" style={{ padding: "var(--space-md)", display: "flex", flexDirection: "column", height: "100%" }}>
			<div className="label" style={{ marginBottom: "var(--space-xs)" }}>บันทึกสด</div>
			<p className="hint" style={{ margin: "0 0 var(--space-sm)" }}>ข้อความเข้า-ออกของบอทที่เลือกอยู่ แบบเรียลไทม์</p>
			<div style={{ overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: "var(--space-xs)" }}>
				{items.length === 0 && (
					<div style={{ color: "var(--text-dim)", fontSize: "var(--text-sm)", padding: "var(--space-sm) 0" }}>
						ยังไม่มีข้อความ — กำลังรอข้อความเข้า
					</div>
				)}
				{newestFirstItems.map((item) => (
					<FeedRow
						key={item.id}
						item={item}
						answerMs={answerTimes.get(item.id)}
						botName={showBotTag ? botNameById?.[item.data.botId] : undefined}
					/>
				))}
			</div>
		</section>
	);
}

function BotTag({ name }: { name: string }) {
	return (
		<span className="chip chip--idle mono" style={{ fontSize: "var(--text-xs)", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={name}>
			{name}
		</span>
	);
}

function FeedRow({ item, answerMs, botName }: { item: FeedItem; answerMs?: number; botName?: string }) {
	if (item.kind === "in") {
		const { data } = item;
		return (
			<div style={row}>
				<span className="mono" style={timeStyle}>{timeLabel(data.ts)}</span>
				{botName !== undefined && <BotTag name={botName} />}
				<span className="chip chip--idle" style={{ minWidth: 58, justifyContent: "center" }}>
					{data.surface}
				</span>
				<span style={{ color: "var(--text-dim)", fontSize: var_xs }}>เข้า</span>
				<span style={{ flex: 1, fontSize: "var(--text-sm)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
					{data.text}
				</span>
				{/* A LINE-clock gap between inbound messages. It is contextual
				    room traffic, not a phase of this bot's reply TOTAL. */}
				{answerMs !== undefined && (
					<span
						className={`chip ${toneForAnswer(answerMs)} mono`}
						title={`ΔIN: ห่างจากข้อความเข้าก่อนหน้า ${answerMs}ms บนเวลา LINE · ไม่รวมใน TOTAL ของบอท`}
					>
						ΔIN {answerMs}ms
					</span>
				)}
			</div>
		);
	}

	const { data } = item;
	const measured = data.breakdown ? sumLatencyBreakdown(data.breakdown) : undefined;
	const totalMs = measured?.totalMs ?? data.latencyMs;
	const tone = !data.ok ? "chip--bad" : totalMs <= 300 ? "chip--go" : totalMs <= 800 ? "chip--warn" : "chip--bad";
	return (
		<div style={{ ...row, display: "block" }}>
			<div style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)" }}>
			<span className="mono" style={timeStyle}>{timeLabel(data.ts)}</span>
			{botName !== undefined && <BotTag name={botName} />}
			<span className="chip chip--idle" style={{ minWidth: 58, justifyContent: "center" }}>
				{data.surface}
			</span>
			<span style={{ color: "var(--signal-go)", fontSize: var_xs }}>ออก</span>
			<span style={{ flex: 1, fontSize: "var(--text-sm)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
				{data.textPreview}
			</span>
			<span className={`chip ${tone} mono`} title="ผลรวมของ phase ที่ไม่ทับซ้อนกัน">{ms(totalMs)}</span>
			<span className="label">{data.source === "auto" ? "อัตโนมัติ" : "ทดสอบ"}</span>
			</div>
			{data.breakdown && (
				<div className="mono" style={{ display: "flex", gap: "var(--space-md)", flexWrap: "wrap", margin: "0.35rem 0 0 98px", color: "var(--text-dim)", fontSize: "var(--text-xs)" }}>
					<strong style={{ color: "var(--text-primary)" }}>Σ {ms(measured!.totalMs)} =</strong>
					<Metric label="LINE" value={data.breakdown.lineMs} budget={BUDGET.line} />
					<Metric label="decrypt" value={data.breakdown.decryptMs} budget={BUDGET.code} />
					<Metric label="match" value={data.breakdown.matchMs} budget={BUDGET.code} />
					<Metric label="limiter" value={data.breakdown.limiterMs} budget={BUDGET.code} />
					<Metric label="protocol" value={data.breakdown.protocolPrepMs} budget={BUDGET.protocol} />
					<Metric label="relay encode" value={data.breakdown.relayEncodeMs} budget={BUDGET.transport} />
					<Metric label="transport/parse" value={data.breakdown.relayAndParseMs} budget={BUDGET.transport} />
					<Metric label="Go" value={data.breakdown.goPrepMs} budget={BUDGET.go} />
					<span>calls {data.breakdown.upstreamCalls}</span>
				</div>
			)}
		</div>
	);
}

/** One labelled timing, coloured by how it compares to its own budget. */
function Metric({ label, value, budget }: { label: string; value: number; budget: Budget }) {
	return (
		<span>
			{label}{" "}
			<b
				style={{ color: toneFor(value, budget) }}
				title={`${label}: ปกติ ≤ ${budget[0]}ms · เริ่มช้า ≤ ${budget[1]}ms · ช้ากว่านั้นถือว่าผิดปกติ`}
			>
				{ms(value)}
			</b>
		</span>
	);
}

const var_xs = "var(--text-xs)";

const row: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: "var(--space-sm)",
	padding: "0.4rem 0.5rem",
	borderRadius: "var(--radius-sm)",
	background: "var(--bg-inset)",
	animation: "row-in var(--duration-normal) var(--ease-out-expo)",
};

const timeStyle: CSSProperties = { color: "var(--text-dim)", fontSize: "var(--text-xs)", width: 90, flexShrink: 0 };
