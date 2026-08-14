# Server 2 production workers

Server 2 runs one public control-plane worker and, when enabled, one or more
owner-scoped workers. All processes use the same local SQLite database, but an
owner belongs to exactly one runtime process. Split by `owner_user_id`, never by
an individual bot: sibling-bot coordination is in memory and every current and
future bot for that owner must move together.

## Configuration sources

| Process | Unit | Environment source | Listen port |
| --- | --- | --- | --- |
| Primary/control plane | `linebot-worker` | `/etc/linebot/worker.env` | 8791 |
| Shard B | `linebot-worker-shard-b` | `/etc/linebot/worker-shard-b.env` | 8792 |

Both files are `root:linebot` mode `0640`. Production releases contain no
`.env`, `.env.local`, or `.env.production`. Both units run Bun with
`--no-env-file`, so a stale file in a current or rollback release cannot merge
the primary's scope into a shard. Do not use
`/opt/linebot/current/backend/.env` for production configuration.

The unit files deliberately define empty topology defaults before their
required `EnvironmentFile`. This clears any manager-wide values while allowing
the service-specific file to supply the real values.

## Required topology invariant

For the owner-2 / bot-117 split, the effective settings are:

| Key | Primary | Shard B |
| --- | --- | --- |
| `WORKER_OWNER_SCOPE` | unset | `2` |
| `WORKER_OWNER_EXCLUDE` | `2` | unset |
| `WORKER_OWNER_ROUTES` | `2=http://127.0.0.1:8792` | unset |
| `CONTROL_PLANE_URL` | unset | `http://127.0.0.1:8791` |
| `CONTROL_PLANE_TOKEN` | same 32+ character secret | same secret |
| `SQUARE_FAST_POLL_INTERVAL_MS` | `100` | `50` |
| `SQUARE_FAST_POLL_ALLOW_50MS` | unset | `1` |

With multiple shards, the primary's excluded-owner set must exactly equal the
union of every enabled shard scope. `WORKER_OWNER_ROUTES` must map every one of
those owners to its shard loopback port, with no duplicates or overlaps. The
backend validates this topology before starting the sender or any LINE session.

Port 8791 remains the only public API/WebSocket target. The control plane
proxies owner-specific API operations to the correct shard, while shards relay
runtime events back to it using `CONTROL_PLANE_TOKEN`. Host-global jobs run only
on the control plane. Ports 8791 and 8792 remain loopback/private listeners;
never expose a shard port publicly.

## Atomic shard-B cutover and rollback

Run the repository-root helper on Server 2 as root:

```bash
sudo /opt/linebot/current/setup-shard-b.sh 2
```

The helper:

1. validates owner IDs and records every running bot;
2. backs up env files, units, gate, sudoers, and service state under
   `/var/backups/linebot-shard-b/<timestamp>`;
3. generates a fresh shared control-plane token and builds both env files
   without duplicate topology or fast-poll keys;
4. installs the `--no-env-file` units and restricted deploy sudoers rule;
5. stops both processes before ownership changes, preventing duplicate LINE
   sessions;
6. starts shard B first and then the primary, checking scope, topology, token,
   fast-poll gate, listeners, and bot online state;
7. automatically restores the entire pre-cutover topology if any check fails.

The script prints the exact backup path. Manual rollback is:

```bash
sudo /opt/linebot/current/setup-shard-b.sh --rollback \
  /var/backups/linebot-shard-b/<timestamp>
```

Rollback stops both processes before restoring files and resumes only bots that
were running, so it does not deliberately resurrect a bot stopped after the
cutover.

## Normal deploys with shards enabled

`deploy-server2.sh` treats code as one shared release transaction. Before the
symlink switch it verifies:

- the release has no production env file;
- enabled shard scopes are disjoint;
- primary exclude/routes exactly match enabled shard ownership;
- shard control-plane URLs and shared tokens match the primary;
- a requested 50 ms interval has the explicit opt-in gate.

It then restarts the primary and every enabled shard. If any process does not
return active, the shared symlink is restored and every worker is restarted on
the previous release. A shard failure is not a partial-success deploy.

## Inspection and tuning

Tail both processes when investigating bot 117 or cross-bot load:

```bash
journalctl -u linebot-worker -u linebot-worker-shard-b \
  -n 200 -f --no-hostname -o short-iso-precise
```

On Windows, `watch-log-bigsa.bat` runs that command through the Server 1 jump
host and intentionally keeps all bot/infrastructure lines. Before each tail it
records service/PID state, non-secret effective topology, and the shared bot
inventory. The same unfiltered stream is displayed and appended to a
timestamped `logs/bigsa-*.log`; `logs/` is Git-ignored because journals contain
operational user/message metadata. `CONTROL_PLANE_TOKEN` is never included in
the snapshot.

Configuration and latency tools require an explicit worker selection:

```powershell
.\scripts\Set-WorkerConfig.ps1 -Worker ShardB -Show
```

```bash
bash scripts/ab-latency.sh --worker shard-b config
bash scripts/ab-latency.sh --worker shard-b collect isolated-50ms 10
```

`Set-WorkerConfig.ps1` writes only the selected `/etc/linebot/*.env` file and
refuses coupled topology keys; use `setup-shard-b.sh` for those. The latency
tool reads the selected systemd unit's actual process environment, records a
separate CSV per worker, and filters the shared database to that worker's owner
scope.

## Initial host cutover safety

Server 1 remains the TLS/Nginx edge and proxies `/api` plus `/ws` to Server 2
over WireGuard. Never copy a live SQLite file or run the same LINE account on
both hosts. During a host-level cutover, stop the old backend, copy the stopped
database and secrets to root-owned Server 2 paths, verify every expected bot and
an ACK-confirmed reply, and keep the Nginx rollback ready until observation is
complete.
