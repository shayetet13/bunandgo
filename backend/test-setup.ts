/**
 * Bun test preload (see bunfig.toml). Tests run against a fresh `:memory:`
 * database (NODE_ENV=test), so there is never a pre-existing admin row —
 * bootstrapAdmin() requires ADMIN_USERNAME/ADMIN_PASSWORD to create one.
 * These are fixture-only values, never used against a real database.
 */
process.env.ADMIN_USERNAME ??= "test-admin";
process.env.ADMIN_PASSWORD ??= "test-admin-password-fixture";

// session-manager.ts requires this at module load time (shared secret with
// backend/sender). Setting it here means whichever test file happens to be
// the first to pull that module in transitively no longer depends on load
// order relative to worker-proxy.test.ts's own inline fallback.
process.env.DISPATCH_TOKEN ??= "test-dispatch-token-fixture";
