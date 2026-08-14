import { lazy, Suspense, useEffect, useState } from "react";
import { api } from "./lib/api.ts";
import { LoginPage } from "./components/LoginPage.tsx";
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

	function refreshAuth() {
		api
			.me()
			.then((r) => {
				setAuthenticated(r.authenticated);
				setUsername(r.username ?? "");
				setRole(r.role ?? "user");
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
