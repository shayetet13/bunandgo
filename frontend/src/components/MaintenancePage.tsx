import { api } from "../lib/api.ts";

interface MaintenancePageProps {
	username: string;
	onLogout: () => void;
}

/**
 * A robot head on standby: HUD corner brackets frame it like a targeting
 * reticle, pulse rings + a blinking antenna say "still alive", a single
 * glowing visor bar says "resting, not broken", and a faint scanline keeps
 * sweeping the face — it's paused, not powered down. The float wrapper is a
 * separate element from .maint-reveal so the one-shot entrance drop and the
 * continuous idle bob don't fight over the same `transform` (see
 * .maint-badge-float in global.css).
 */
function MaintenanceBadge() {
	return (
		<div className="maint-badge-wrap">
			<div className="maint-badge-float">
				<svg viewBox="0 0 120 120" width="100%" height="100%" aria-hidden="true">
					<defs>
						<linearGradient id="maintHeadGrad" x1="0" y1="0" x2="1" y2="1">
							<stop offset="0%" stopColor="#2a3c58" />
							<stop offset="100%" stopColor="#0f1626" />
						</linearGradient>
						<linearGradient id="maintEdgeGrad" x1="0" y1="0" x2="1" y2="1">
							<stop offset="0%" stopColor="#22d3ee" />
							<stop offset="100%" stopColor="#a78bfa" />
						</linearGradient>
						<clipPath id="maintHeadClip">
							<rect x="26" y="32" width="68" height="60" rx="20" />
						</clipPath>
					</defs>

					<circle className="maint-pulse-ring" data-ring="1" cx="60" cy="62" r="44" />
					<circle className="maint-pulse-ring" data-ring="2" cx="60" cy="62" r="44" />

					{/* HUD corner brackets — a targeting-reticle frame around the head */}
					<path className="maint-hud" d="M14,26 L14,14 L26,14" />
					<path className="maint-hud" d="M94,14 L106,14 L106,26" />
					<path className="maint-hud" d="M14,98 L14,110 L26,110" />
					<path className="maint-hud" d="M106,98 L106,110 L94,110" />

					<line x1="60" y1="32" x2="60" y2="20" stroke="url(#maintEdgeGrad)" strokeWidth="3" strokeLinecap="round" />
					<circle className="maint-antenna-dot" cx="60" cy="17" r="4" fill="#22d3ee" />

					<rect x="26" y="32" width="68" height="60" rx="20" fill="url(#maintHeadGrad)" stroke="url(#maintEdgeGrad)" strokeWidth="2" />
					<rect
						className="maint-scanline"
						x="26"
						y="58"
						width="68"
						height="8"
						fill="#22d3ee"
						clipPath="url(#maintHeadClip)"
					/>

					<rect x="36" y="54" width="48" height="20" rx="10" fill="#050810" stroke="rgba(34,211,238,0.35)" />
					<line className="maint-eye" x1="44" y1="64" x2="76" y2="64" stroke="#22d3ee" strokeWidth="4" strokeLinecap="round" />
				</svg>
			</div>
		</div>
	);
}

/**
 * Replaces the whole user console while maintenance mode is on — see
 * backend/src/bot/maintenance-mode.ts. The bot itself keeps answering
 * messages exactly as before; this is only what a "user"-role account sees
 * in the browser until an admin flips the toggle back off from Settings.
 *
 * Deliberately not styled like the rest of the app's green telemetry look
 * (see .maint in global.css) — a glowing cyan/violet "robot on standby"
 * moment instead.
 */
export function MaintenancePage({ username, onLogout }: MaintenancePageProps) {
	async function logout() {
		await api.logout().catch(() => {});
		onLogout();
	}

	return (
		<div className="maint">
			<header className="maint-topbar">
				<span className="maint-username">{username}</span>
				<button className="maint-logout" onClick={() => void logout()}>
					ออกจากระบบ
				</button>
			</header>

			<main className="maint-hero">
				<div className="maint-card">
					<div className="maint-reveal">
						<MaintenanceBadge />
					</div>
					<span className="maint-eyebrow maint-reveal">System Standby</span>
					<h1 className="maint-title maint-reveal">ตอนนี้ระบบปิดปรับปรุง</h1>
					<p className="maint-pill maint-reveal">
						<span className="maint-pill-dot" aria-hidden="true" />
						บอทของคุณยังทำงานอยู่ตามปกติ
					</p>
					<p className="maint-support maint-reveal">
						หน้าจัดการบอทปิดใช้งานชั่วคราวเท่านั้น ระบบจะเปิดให้ใช้งานอีกครั้งเร็วๆ นี้ — กรุณากลับมาตรวจสอบใหม่ภายหลัง
					</p>
				</div>
			</main>
		</div>
	);
}
