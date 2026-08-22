# Server 2 production workers

Server 2 runs two permanent runtime processes against one shared SQLite
database. Primary is the public control plane on port 8791; Shard B is private
on port 8792. An owner and all of that owner's bots always run in exactly one
process.

## Permanent topology

The source of truth is `/opt/linebot/shared/worker-topology.json`. Start from
`worker-topology.example.json`, replace both placeholder secrets, then install
the file as `linebot:linebot` mode `0600` before restarting either service.

The production invariants are:

| Property              | Primary                         | Shard B                          |
| --------------------- | ------------------------------- | -------------------------------- |
| Worker ID             | `primary`                       | `shard-b`                        |
| API port              | 8791                            | 8792, loopback only              |
| LINE lane source      | 16 local Server 2 lanes         | 16 Server 3 relay lanes          |
| Send-reserved lanes   | 4                               | 4                                |
| Zero-delay poll slots | 8                               | 8                                |
| Owner allocation      | first new owner, then every tie | second new owner, then every tie |

`assignmentMode: balanced-sticky` persists the selected worker in
`owner_worker_assignments` when an owner creates the first bot. Allocation uses
the worker with fewer owners and Primary wins a tie. Later bot creation, login,
reconnect, restart, and deploy all reuse that row; existing owners are never
rebalanced automatically. Deleting the user removes its obsolete assignment.

Primary routes requests for Shard B owners over loopback. Shard B accepts only
authenticated forwards from Primary and reports events back to Primary. Both
services share `CONTROL_PLANE_TOKEN`, but the token lives only in the protected
runtime topology. Server 3's separate `relayReportToken` is stored there too,
so the root-owned env file never needs to change during token rotation. Static
`WORKER_OWNER_SCOPE`, `WORKER_OWNER_EXCLUDE`, and
`WORKER_OWNER_ROUTES` values remain empty.

## Lane and latency policy

Both workers use 16 effective H2 lanes: four are reserved for sends and twelve
are available for polling. Eight zero-delay poll slots can be active per
worker. The scheduler explores the complete poll pool every two seconds, ranks
real application samples, treats `<20ms` as hot, permits `20–<23ms` only as
warm capacity, and marks known `>=23ms` lanes degraded for repair.

Server 3 owns no bot, login, session, database, or public API runtime. It only
maintains the relay lane pools. Its one-second report is stale after three
seconds. Shard B is fail-closed: if the relay is unavailable or has accepted a
request and returned an error, the request is not retried locally. This avoids
egress changes and duplicate LINE sends.

Application reply telemetry also reports guardrails at 40/50/60/80/90/100ms.
These are measurement and incident thresholds, not a promise that an external
network can never exceed them. The scheduler never queues a request just to
hide a slow result.

## Service configuration

| Process | Unit                     | Environment source                |
| ------- | ------------------------ | --------------------------------- |
| Primary | `linebot-worker`         | `/etc/linebot/worker.env`         |
| Shard B | `linebot-worker-shard-b` | `/etc/linebot/worker-shard-b.env` |

Both env files are `root:linebot` mode `0640`. Units run Bun with
`--no-env-file`, so release-local `.env` files cannot merge settings between
workers. Ports 8791 and 8792 must remain private; Server 1 is the only TLS edge.

`deploy-server2.sh` validates the shared file through the production parser,
tests the release, switches one shared release symlink, and restarts both
workers together. If either process or listener fails, it restores the prior
release for both workers. The legacy static-scope validation remains only for
safe rollback of releases created before the sticky topology migration.

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

The control-plane metrics endpoint is the authoritative combined view. Relay
health is available only over the WireGuard address on Server 3 and returns
HTTP 200 only when every configured origin has its full lane pool ready.

Never copy a live SQLite file or run the same LINE account from another host.
For host rollback, stop both workers before moving the database and resume only
after the previous pair has fully stopped.
