# Server 2 production workers

Server 2 runs two permanent runtime processes against one shared SQLite
database. Primary is the public control plane on port 8791; Shard B is
private, on port 8792. An owner and all of that owner's bots always run in
exactly one process.

Splitting bot owners across worker processes is a CPU-count fix, not a
network-tuning one: each process's reply/poll hot path is a single JS event
loop, so a busy fleet (15+ concurrently active bots) needs one process per
free core, not a bigger lane pool on one process. **This host has 2 vCPUs
(`nproc`), so 2 workers is the ceiling** — a Shard C was added once (commit
`4db097b`) on the assumption of a third free core that was never actually
provisioned on this box, which left 3 single-threaded processes fighting over
2 cores and was removed again. Only add Shard C back once this host (or its
replacement) genuinely has a third core to give it — verify with `nproc`
before adding the unit, not after. The same pattern (another
`linebot-worker-shard-*.service` + a `shards[]` entry in
`worker-topology.json`) still applies whenever a shard's own CPU/event-loop
watchdog samples run hot on a box that actually has the core to spare.

## Permanent topology

The source of truth is `/opt/linebot/shared/worker-topology.json`. Start from
`worker-topology.example.json`, replace the placeholder secret, then install
the file as `linebot:linebot` mode `0600` before restarting every service.

The production invariants are:

| Property              | Primary                            | Shard B                             |
| ---------------------- | ----------------------------------- | ------------------------------------ |
| Worker ID             | `primary`                          | `shard-b`                           |
| API port              | 8791                                | 8792, loopback only                 |
| LINE lane source      | 16 local                            | 16 local                             |
| Send-reserved lanes   | 4                                    | 4                                     |
| Zero-delay poll slots | 8                                    | 8                                     |
| Owner allocation      | fewest owners, ties land here first | fewest owners, ties land here second |

`assignmentMode: balanced-sticky` persists the selected worker in
`owner_worker_assignments` when an owner creates the first bot. Allocation uses
the worker with fewer owners; a tie goes to whichever worker appears first in
`WORKER_ASSIGNMENT_WORKERS` (Primary, then Shard B — this order is derived
automatically from the `primary`/`shards` order in `worker-topology.json`).
Later bot creation, login, reconnect, restart, and deploy all reuse that row —
**existing owners are never rebalanced automatically**, so adding a future
shard only changes where *new* owners land. To spread bots that were assigned
before a shard existed, update the affected rows in `owner_worker_assignments`
by hand and restart each of those bots so it reconnects on its newly assigned
worker. Deleting the user removes its obsolete assignment.

Primary routes requests for Shard B owners over loopback. The shard accepts
only authenticated forwards from Primary and reports events back to Primary.
Both services share `CONTROL_PLANE_TOKEN`, but the token lives only in the
protected runtime topology. Static `WORKER_OWNER_SCOPE`,
`WORKER_OWNER_EXCLUDE`, and `WORKER_OWNER_ROUTES` values remain empty.

## Lane and latency policy

Primary and Shard B each own 16 process-local H2 lanes. Four
low-numbered lanes are the cold-start send preference and eight zero-delay
poll slots can be active per worker. SEND and POLL measurements never rank each other.
SEND routing predicts each candidate's completion time per bot from up to the
seven most recent SEND results for that bot's own route key (falling back to
the lane's shared history when that bot has no fresh sample yet):
`p50 + (p95 - p50) x 0.35 + queue waves x p50`, where a queue wave only exists
once `inFlight` reaches the peer's own advertised HTTP/2 `maxConcurrentStreams`
— `inFlight` is never turned into an invented millisecond penalty, and it
still only breaks an exact predicted-time tie. A raw SEND result above 23ms
cools that bot's route on that lane for 15 seconds while an alternative
exists, without cooling the lane for every other bot. If every route is
cooling, the lowest predicted route still carries the request so the
guardrail cannot turn a network-wide slowdown into dropped messages.

A request is sent through exactly one local lane and is never retried through
another after it may have reached LINE, avoiding duplicate LINE sends.

Application reply telemetry also reports guardrails at 40/50/60/80/90/100ms.
These are measurement and incident thresholds, not a promise that an external
network can never exceed them. The scheduler never queues a request just to
hide a slow result.

## Service configuration

| Process | Unit                     | Environment source                |
| ------- | ------------------------ | --------------------------------- |
| Primary | `linebot-worker`         | `/etc/linebot/worker.env`         |
| Shard B | `linebot-worker-shard-b` | `/etc/linebot/worker-shard-b.env` |

All env files are `root:linebot` mode `0640`. Units run Bun with
`--no-env-file`, so release-local `.env` files cannot merge settings between
workers. Ports 8791 and 8792 must remain private; Server 1 is the only
TLS edge.

`deploy-server2.sh` validates the shared file through the production parser,
tests the release, switches one shared release symlink, and restarts every
worker together. If any process or listener fails, it restores the prior
release for all of them. The legacy static-scope validation remains only for
safe rollback of releases created before the sticky topology migration.
The restart/validation path discovers every enabled
`linebot-worker-shard-*.service` automatically, so a future Shard C (on a box
that actually has the free core for it) needs no script change — just a new
unit file, an env file, and a `shards[]` entry in `worker-topology.json`
following Shard B's pattern, then restart Primary too since it re-reads the
same topology file at boot and needs to learn about the new peer.

## Inspection

```bash
journalctl -u linebot-worker -u linebot-worker-shard-b \
  -n 200 -f --no-hostname -o short-iso-precise
```

Inspect owner placement without exposing tokens:

```bash
sqlite3 /opt/linebot/shared/worker.db \
  'SELECT owner_user_id, worker_id, assigned_at FROM owner_worker_assignments ORDER BY owner_user_id;'
```

The control-plane metrics endpoint is the authoritative combined view of both
local worker processes.

Never copy a live SQLite file or run the same LINE account from another host.
For host rollback, stop every worker before moving the database and resume
only after the previous set has fully stopped.
