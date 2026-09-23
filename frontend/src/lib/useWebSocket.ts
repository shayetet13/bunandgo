import { useEffect, useRef, useState } from "react";
import type { WsEvent, WsEventType } from "./types.ts";

type Handler = (data: unknown) => void;

/**
 * One shared WS connection with auto-reconnect (1s backoff — this console
 * lives or dies by realtime feedback, so staying connected matters more
 * than a graceful degrade path). Consumers register per-event-type
 * handlers via `on`. Returns live connection state for status indicators.
 */
export function useLiveSocket(handlers: Partial<Record<WsEventType, Handler>>): boolean {
	const handlersRef = useRef(handlers);
	handlersRef.current = handlers;
	const [connected, setConnected] = useState(false);

	useEffect(() => {
		let socket: WebSocket | undefined;
		let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
		let stopped = false;

		function connect() {
			const protocol = location.protocol === "https:" ? "wss" : "ws";
			socket = new WebSocket(`${protocol}://${location.host}/ws`);
			socket.onopen = () => setConnected(true);
			socket.onmessage = (event) => {
				let parsed: WsEvent;
				try {
					parsed = JSON.parse(event.data) as WsEvent;
				} catch {
					// Only a malformed frame is expected to land here.
					return;
				}
				// Deliberately a separate try from the one above: a bug in a
				// consumer's handler (e.g. an unvalidated `data as {...}` cast
				// meeting a payload shape it didn't expect) must not be
				// relabeled as "malformed frame" and silently discarded — that
				// hid real application errors from both the console and the
				// user. Reported instead of left to throw, so one bad handler
				// invocation can't be mistaken for the socket itself failing.
				try {
					handlersRef.current[parsed.type]?.(parsed.data);
				} catch (error) {
					console.error(`useLiveSocket: handler for "${parsed.type}" threw`, error);
				}
			};
			socket.onclose = () => {
				setConnected(false);
				if (!stopped) reconnectTimer = setTimeout(connect, 1000);
			};
		}

		// Chrome force-closes an open socket the instant a page enters the
		// back-forward cache (bfcache) instead of freezing it — but that
		// teardown happens alongside this closure's own JS, so onclose above
		// never runs and no reconnect ever gets scheduled. A bfcache restore
		// resumes this exact closure with `connected` still true and `socket`
		// still pointing at that dead connection, silently dropping every
		// event until someone manually refreshes. pageshow's `persisted` flag
		// is the standard cross-browser signal for "this is a bfcache
		// restore, not a fresh load" (see web.dev/articles/bfcache).
		function handlePageShow(event: PageTransitionEvent) {
			if (!event.persisted) return;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			socket?.close();
			connect();
		}

		// Closing cleanly before the freeze avoids the "Page entered
		// Back-Forward Cache" console error and guarantees handlePageShow
		// starts its reconnect from a known-closed socket, rather than
		// racing whatever onclose's own setTimeout does across the freeze.
		function handlePageHide(event: PageTransitionEvent) {
			if (event.persisted) socket?.close();
		}

		connect();
		window.addEventListener("pageshow", handlePageShow);
		window.addEventListener("pagehide", handlePageHide);

		return () => {
			stopped = true;
			window.removeEventListener("pageshow", handlePageShow);
			window.removeEventListener("pagehide", handlePageHide);
			if (reconnectTimer) clearTimeout(reconnectTimer);
			socket?.close();
		};
	}, []);

	return connected;
}
