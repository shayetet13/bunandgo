/**
 * Parses the scheduled-post console's single `ss.mmm` field into the seconds
 * and milliseconds a `datetime-local` value needs appended to it.
 *
 * Why the field exists at all: a phone's native date picker stops at minutes,
 * so the sub-minute part has to be typed no matter what. Why it is one field
 * and not two: "5.25" is how a person already writes five and a quarter
 * seconds, whereas two adjacent boxes pre-filled with `00` and `000` and
 * labelled 0-59 and 0-999 read like a form to fill in rather than a time.
 *
 * Returns undefined instead of clamping. This schedules a race to post first,
 * so a typo quietly becoming :00.000 would miss the target by whole seconds —
 * the caller surfaces it as a validation error instead.
 */
export interface SecondsAndMs {
	seconds: number;
	ms: number;
}

export function parseSecondsAndMs(raw: string): SecondsAndMs | undefined {
	const trimmed = raw.trim();
	// Empty is not a mistake: it means the top of the chosen minute, which is
	// what someone who only cares about the minute would expect to leave blank.
	if (trimmed === "") return { seconds: 0, ms: 0 };

	const match = /^(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(trimmed);
	if (!match) return undefined;

	const seconds = Number(match[1]);
	if (seconds > 59) return undefined;

	// Decimal semantics, not a separate counter: ".2" is two hundred
	// milliseconds the way 5.2 seconds is, not two.
	return { seconds, ms: match[2] ? Number(match[2].padEnd(3, "0")) : 0 };
}

/** Renders a parsed pair back into the `:ss.mmm` suffix `bangkokInputToEpochMs` expects. */
export function secondsSuffix({ seconds, ms }: SecondsAndMs): string {
	return `:${String(seconds).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}
