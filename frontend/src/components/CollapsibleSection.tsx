import { useState, type ReactNode } from "react";

interface CollapsibleSectionProps {
	title: ReactNode;
	meta?: ReactNode;
	summary?: ReactNode;
	defaultOpen?: boolean;
	children: ReactNode;
}

/**
 * A minimal disclosure row: header always visible (title + a compact summary
 * so the collapsed state still answers "is this healthy"), body expands
 * in-place. Height animates via a CSS grid-rows trick instead of measuring
 * the DOM, so it never fights layout or needs a resize observer.
 */
export function CollapsibleSection({ title, meta, summary, defaultOpen = false, children }: CollapsibleSectionProps) {
	const [open, setOpen] = useState(defaultOpen);

	return (
		<div className={`collapsible${open ? " is-open" : ""}`}>
			<button type="button" className="collapsible-trigger" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
				<svg className="collapsible-caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
					<path d="M2 1l5 4-5 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
				</svg>
				<span className="collapsible-heading">
					<span className="collapsible-title">{title}</span>
					{meta && <span className="collapsible-meta">{meta}</span>}
				</span>
				{summary && <span className="collapsible-summary">{summary}</span>}
			</button>
			<div className="collapsible-body">
				<div className="collapsible-body-inner">{children}</div>
			</div>
		</div>
	);
}
