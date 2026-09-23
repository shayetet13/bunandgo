# Server 2 production worker

Server 2 runs one runtime process, `linebot-worker`, on port 8791. Every bot of
every owner runs in it, and it owns its own SQLite database file. There is no
sharding, owner assignment, or CPU pinning: the OS scheduler decides which core
the process (and the Go sender it spawns) runs on.

Server 1 is the only TLS edge and proxies `/api` and `/ws` to port 8791, which
must stay private.

## Lane and latency policy

The worker owns 16 process-local H2 lanes (`LINE_H2_LANES`). Four
low-numbered lanes are the cold-start send preference
(`LINE_H2_SEND_RESERVED_LANES`) and eight zero-delay poll slots can be active
(`SQUARE_FAST_POLL_SLOTS`); a bot beyond those slots polls at 100ms. SEND and
POLL measurements never rank each other.
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

| Process | Unit             | Environment source        |
| ------- | ---------------- | ------------------------- |
| Worker  | `linebot-worker` | `/etc/linebot/worker.env` |

Start from `worker.env.example`. The env file is `root:linebot` mode `0640`.
The unit runs Bun with `--no-env-file`, so a release-local `.env` cannot merge
settings into it.

`deploy-server2.sh` tests the release, switches the release symlink, and
restarts the worker. If the restart fails or the service does not come up, it
restores the prior release.

## Inspection

```bash
journalctl -u linebot-worker -n 200 -f --no-hostname -o short-iso-precise
```

Never copy a live SQLite file or run the same LINE account from another host.
For host rollback, stop the worker before moving the database and resume only
after it has fully stopped.

## History: the old sharded layout

Server 2 used to run a Primary + Shard B (later + Shard C) split, each its own
systemd unit and `/etc/linebot/worker-shard-*.env`, reading lane/poll-slot
overrides from `/opt/linebot/shared/worker-topology.json`. That has been fully
cut over: every shard unit, its env files, and its gate files are gone from
Server 2, and one process runs every owner's bots. `LINE_H2_LANES`,
`LINE_H2_SEND_RESERVED_LANES`, and `SQUARE_FAST_POLL_SLOTS` in
`/etc/linebot/worker.env` are the only source for those values now — nothing
overrides them. `worker-topology.json` and the `owner_worker_assignments`
table are inert leftovers from that era; sudoers entries for the shard units
should be removed too if they're still present.
