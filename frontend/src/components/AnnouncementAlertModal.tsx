import { useState } from "react";
import type { Announcement } from "../lib/types.ts";

/**
 * Center-screen alert for announcements an admin flagged as "must know",
 * separate from the ordinary inline notice card — see AnnouncementsPage.tsx's
 * isModalAlert checkbox. Multiple flagged announcements page through one
 * modal instead of stacking, so a user is never shown more than one at once.
 */
interface AnnouncementAlertModalProps {
	announcements: readonly Announcement[];
	onDismiss: () => void;
}

export function AnnouncementAlertModal({ announcements, onDismiss }: AnnouncementAlertModalProps) {
	const [index, setIndex] = useState(0);
	if (announcements.length === 0) return null;
	const clampedIndex = Math.min(index, announcements.length - 1);
	const current = announcements[clampedIndex]!;
	const hasMultiple = announcements.length > 1;

	return (
		<div className="announcement-modal-backdrop" onClick={onDismiss}>
			<div className="panel announcement-modal" onClick={(e) => e.stopPropagation()}>
				<div className="announcement-modal-icon" aria-hidden="true">
					!
				</div>
				{hasMultiple && (
					<div className="announcement-modal-pager">
						<button
							type="button"
							className="announcement-modal-arrow"
							aria-label="ประกาศก่อนหน้า"
							disabled={clampedIndex === 0}
							onClick={() => setIndex((i) => Math.max(0, i - 1))}
						>
							‹
						</button>
						<div className="announcement-modal-dots">
							{announcements.map((item, i) => (
								<span key={item.id} className="announcement-modal-dot" data-active={i === clampedIndex} />
							))}
						</div>
						<button
							type="button"
							className="announcement-modal-arrow"
							aria-label="ประกาศถัดไป"
							disabled={clampedIndex === announcements.length - 1}
							onClick={() => setIndex((i) => Math.min(announcements.length - 1, i + 1))}
						>
							›
						</button>
					</div>
				)}
				<h2 className="announcement-modal-title">{current.title}</h2>
				<p className="announcement-modal-body">{current.body}</p>
				<div className="announcement-modal-actions">
					<button type="button" onClick={onDismiss}>
						รับทราบ
					</button>
				</div>
			</div>
		</div>
	);
}
