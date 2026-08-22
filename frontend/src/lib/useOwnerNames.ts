import { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { UserRole } from "./types.ts";

/**
 * Owner id -> username, for labelling grouped-bot sections/dropdowns with a
 * name instead of a raw id. GET /api/users is admin-only, so a non-admin
 * caller (who only ever sees their own bots anyway, per
 * listBotsForUser()) gets an empty map rather than a failed request.
 */
export function useOwnerNames(role: UserRole): Record<number, string> {
	const [names, setNames] = useState<Record<number, string>>({});

	useEffect(() => {
		if (role !== "admin") {
			setNames({});
			return;
		}
		let cancelled = false;
		api
			.listUsers()
			.then((users) => {
				if (cancelled) return;
				setNames(Object.fromEntries(users.map((user) => [user.id, user.username])));
			})
			.catch(() => {
				// Falls back to raw ids in the caller's label — not worth surfacing
				// a notification over a display-name nicety.
			});
		return () => {
			cancelled = true;
		};
	}, [role]);

	return names;
}
