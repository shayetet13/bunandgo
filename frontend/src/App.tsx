import { lazy, Suspense, useEffect, useState } from "react";
import { api } from "./lib/api.ts";
import { LoginPage } from "./components/LoginPage.tsx";
import { MaintenancePage } from "./components/MaintenancePage.tsx";
import type { UserRole } from "./lib/types.ts";

const Dashboard = lazy(async () => ({ default: (await import("./Dashboard.tsx")).Dashboard }));
const UserConsole = lazy(async () => ({ default: (await import("./components/UserConsole.tsx")).UserConsole }));

function LoadingScreen() {
	return (
		<div
			className="app-shell"
			style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)" }}
		>
			กำลังโหลด…
		</div>
	);
}

export default function App() {
	const [authenticated, setAuthenticated] = useState<boolean | undefined>(undefined);
	const [username, setUsername] = useState<string>("");
	const [role, setRole] = useState<UserRole>("user");
	const [maintenanceMode, setMaintenanceMode] = useState(false);

	function refreshAuth() {
		api
			.me()
			.then((r) => {
				setAuthenticated(r.authenticated);
				setUsername(r.username ?? "");
				setRole(r.role ?? "user");
				setMaintenanceMode(r.maintenanceMode);
			})
			.catch(() => setAuthenticated(false));
	}

	useEffect(() => {
		refreshAuth();
	}, []);

	if (authenticated === undefined) {
		return <LoadingScreen />;
	}

	if (!authenticated) {
		return <LoginPage onLoggedIn={refreshAuth} />;
	}

	// Admin (and any future non-"user" role) always keeps the full dashboard —
	// otherwise nobody could reach Settings to turn maintenance mode back off.
	if (role === "user" && maintenanceMode) {
		return <MaintenancePage username={username} onLogout={() => setAuthenticated(false)} />;
	}

	return (
		<Suspense fallback={<LoadingScreen />}>
			{role === "user" ? (
				<UserConsole username={username} onLogout={() => setAuthenticated(false)} />
			) : (
				<Dashboard username={username} role={role} onLogout={() => setAuthenticated(false)} />
			)}
		</Suspense>
	);
}
