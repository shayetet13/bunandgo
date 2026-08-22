import { BaseStorage, type Storage } from "../linejs-core/base/storage/mod.ts";
import { db } from "./sqlite.ts";
import { enqueueWrite } from "./write-behind.ts";

/**
 * Bot-scoped storage with a process-wide RAM mirror.
 *
 * The first instance for a bot hydrates while that bot is connecting. Once
 * online, get/set/delete are memory operations; durability is handled by the
 * dedicated SQLite writer worker and never blocks the message event loop.
 */
const caches = new Map<number, Map<string, Storage["Value"]>>();
const loadStmt = db.prepare<{ key: string; value_json: string }, [number]>("SELECT key, value_json FROM kv WHERE bot_id = ?");

function cacheFor(botId: number): Map<string, Storage["Value"]> {
	let cache = caches.get(botId);
	if (cache) return cache;
	cache = new Map();
	for (const row of loadStmt.all(botId)) {
		cache.set(row.key, JSON.parse(row.value_json) as Storage["Value"]);
	}
	caches.set(botId, cache);
	return cache;
}

export class SqliteStorage extends BaseStorage {
	readonly #botId: number;
	readonly #cache: Map<string, Storage["Value"]>;

	constructor(botId: number) {
		super();
		this.#botId = botId;
		this.#cache = cacheFor(botId);
	}

	public async set(key: Storage["Key"], value: Storage["Value"]): Promise<void> {
		this.#cache.set(key, value);
		enqueueWrite({
			kind: "kv_set",
			botId: this.#botId,
			key,
			valueJson: JSON.stringify(value),
		});
	}

	public async get(key: Storage["Key"]): Promise<Storage["Value"] | undefined> {
		return this.#cache.get(key);
	}

	public async delete(key: Storage["Key"]): Promise<void> {
		this.#cache.delete(key);
		enqueueWrite({ kind: "kv_delete", botId: this.#botId, key });
	}

	public async clear(): Promise<void> {
		this.#cache.clear();
		enqueueWrite({ kind: "kv_clear", botId: this.#botId });
	}

	public async migrate(storage: BaseStorage): Promise<void> {
		for (const [key, value] of this.#cache) {
			await storage.set(key, value);
		}
	}
}

export function clearSqliteStorageCache(botId: number): void {
	caches.delete(botId);
}
