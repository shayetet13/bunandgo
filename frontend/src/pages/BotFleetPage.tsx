import type { Bot, UserRole } from "../lib/types.ts";
import { BotsPanel, type ConfirmState, type QrState } from "../components/BotsPanel.tsx";
import { FleetDashboard } from "../components/FleetDashboard.tsx";

interface BotFleetPageProps {
	bots: Bot[];
	role: UserRole;
	selectedBotId?: number;
	onSelect: (bot: Bot) => void;
	qrByBot: Record<number, QrState>;
	confirmByBot: Record<number, ConfirmState>;
	onCreateBot: (name: string) => void;
	onStart: (botId: number) => void;
	onStop: (botId: number) => void;
	onDelete: (botId: number) => void;
	onResetIdLock: (botId: number) => void;
	onForceRelogin: (botId: number) => void;
	onReorder: (botIds: number[]) => Promise<void>;
}

export function BotFleetPage(props: BotFleetPageProps) {
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: "var(--space-lg)" }}>
			<FleetDashboard bots={props.bots} />
			<BotsPanel {...props} />
		</div>
	);
}
