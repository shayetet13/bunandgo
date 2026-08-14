import { useEffect, useState } from "react";
import { api } from "./lib/api.ts";
import { LoginPage } from "./components/LoginPage.tsx";
import { Dashboard } from "./Dashboard.tsx";
import type { UserRole } from "./lib/types.ts";
import { UserConsole } from "./components/UserConsole.tsx";

export default function App() {
	const [authenticated, setAuthenticated] = useState<boolean | undefined>(undefined);
	const [username, setUsername] = useState<string>("");
	const [role, setRole] = useState<UserRole>("user");

	function refreshAuth() {
		api.me()
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
		return (
			<div className="app-shell" style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)" }}>
				กำลังโหลด…
			</div>
		);
	}

	if (!authenticated) {
		return <LoginPage onLoggedIn={refreshAuth} />;
	}

	if (role === "user") {
		return <UserConsole username={username} onLogout={() => setAuthenticated(false)} />;
	}

	return <Dashboard username={username} role={role} onLogout={() => setAuthenticated(false)} />;
}
