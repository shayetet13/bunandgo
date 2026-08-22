import { existsSync, readdirSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { validateWorkerTopology } from "./bot/worker-topology.ts";

// Validate before starting the sender or touching any LINE session. An
// incomplete shard cutover must fail closed instead of running one owner in
// two processes at once.
validateWorkerTopology();

const DISPATCH_TOKEN = process.env.DISPATCH_TOKEN ?? randomBytes(24).toString("hex");
process.env.DISPATCH_TOKEN = DISPATCH_TOKEN;

const DISPATCH_ADDR = process.env.DISPATCH_ADDR ?? "127.0.0.1:4790";
process.env.DISPATCH_ADDR = DISPATCH_ADDR;
process.env.DISPATCH_URL ??= `http://${DISPATCH_ADDR}/dispatch`;

const senderDir = fileURLToPath(new URL("../sender", import.meta.url));
const compiledBinary = process.platform === "win32" ? "sender.exe" : "sender";
const compiledPath = `${senderDir}/${compiledBinary}`;

function senderNeedsBuild(): boolean {
	// A deployed release always ships its binary prebuilt, and `go` is not on
	// PATH under systemd. The mtime comparison below is also meaningless for a
	// deployed release: `git archive` does not preserve original commit times,
	// so the .go source and the binary land with near-identical timestamps and
	// the comparison's outcome depends on extraction-order jitter — this is
	// what crash-looped the worker on 2026-08-09 (rebuild attempted, `go` not
	// found, exit). Trust the shipped binary in production; keep the
	// rebuild-on-change convenience for local development only.
	if (process.env.NODE_ENV === "production") return false;
	if (!existsSync(compiledPath)) return true;
	const binaryMtime = statSync(compiledPath).mtimeMs;
	return readdirSync(senderDir)
		.filter((name) => name.endsWith(".go"))
		.some((name) => statSync(`${senderDir}/${name}`).mtimeMs > binaryMtime);
}

if (senderNeedsBuild()) {
	console.log("sender: Go source changed; rebuilding optimized relay...");
	const build = Bun.spawnSync(["go", "build", "-o", compiledPath, "."], {
		cwd: senderDir,
		stdout: "inherit",
		stderr: "inherit",
	});
	if (build.exitCode !== 0) throw new Error(`sender build failed with exit code ${build.exitCode}`);
}

const senderCommand = [compiledPath];

console.log(`sender: starting via ${senderCommand.join(" ")} (cwd=${senderDir})`);
const senderProc = Bun.spawn(senderCommand, {
	cwd: senderDir,
	env: { ...process.env, DISPATCH_TOKEN, DISPATCH_ADDR },
	stdout: "inherit",
	stderr: "inherit",
});

async function waitForSenderReady(): Promise<void> {
	const healthUrl = `http://${DISPATCH_ADDR}/healthz`;
	for (let attempt = 0; attempt < 50; attempt++) {
		try {
			const res = await fetch(healthUrl);
			if (res.ok) return;
		} catch {
			// sender not up yet
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`sender did not become healthy at ${healthUrl} in time`);
}

function shutdown(): void {
	senderProc.kill();
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Last-resort net. A single bot's LINE session dying (account logged out from
// another device, push stream dropped) surfaces deep inside the protocol layer
// as a detached promise; without this the default behaviour is to kill the
// process, taking every *other* bot offline over one account's problem — and
// since bots don't come back by themselves, they then sit dead until someone
// notices. Logging and staying up lets the per-bot watchdog do its job.
// Deliberately not exiting: there is no state here that a restart repairs.
let applicationReady = false;

function failStartup(): void {
	if (applicationReady) return;
	// A caught startup exception must not leave systemd reporting an active
	// process with no API port or bot runtime. Exit and let Restart=on-failure
	// retry after the transient dependency/lock clears.
	senderProc.kill();
	process.exit(1);
}

process.on("unhandledRejection", (reason) => {
	console.error("[unhandledRejection]", reason instanceof Error ? (reason.stack ?? reason.message) : reason);
	failStartup();
});
process.on("uncaughtException", (err) => {
	console.error("[uncaughtException]", err instanceof Error ? (err.stack ?? err.message) : err);
	failStartup();
});

await waitForSenderReady();
console.log("sender: healthy");

// Server2-only persistence adapter. The Server3 relay entrypoint never imports
// this module, so its lane telemetry remains bounded and memory-only.
await import("./dispatch/lane-race-persistence.ts");

const { startSystemLoadMonitor } = await import("./monitoring/system-load.ts");
startSystemLoadMonitor();

await import("./api/server.ts");
applicationReady = true;
