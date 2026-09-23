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

## Cutting over from the old sharded layout

The old Primary + Shard B setup took its lane and poll-slot settings from
`/opt/linebot/shared/worker-topology.json`. That file is no longer read, so do
these in order on Server 2 **before** running `deploy-server2.sh`:

1. Decide the lane and poll-slot values in `/etc/linebot/worker.env`
   (`LINE_H2_LANES`, `LINE_H2_SEND_RESERVED_LANES`, `SQUARE_FAST_POLL_SLOTS`).
   The topology file used to override whatever the env said, so the values
   that were actually running are the ones in the topology file (16 lanes, 4
   send-reserved, 8 slots per worker in the example). Copy those, or choose
   new ones on purpose: the env is now the only source. With none set the code
   falls back to 6 lanes and 1 fast-poll slot.
2. Stop and disable Shard B, and remove its gate file:
   `systemctl stop linebot-worker-shard-b`,
   `systemctl disable linebot-worker-shard-b`,
   `rm /etc/linebot/worker-shard-b-enabled`. Shard B runs from the same
   `/opt/linebot/current` symlink, so if it is left running while the new
   release starts, its owners' bots log in twice on the same LINE accounts.
3. Run `deploy-server2.sh`. Every bot now resumes inside `linebot-worker`.

Afterwards remove `linebot-worker-shard-*.service`,
`/etc/linebot/worker-shard-*.env`, `/opt/linebot/shared/worker-topology.json`,
and the matching sudoers entries. The `owner_worker_assignments` table stays in
the database, unused, so a rollback to an older release still finds it. Set
`WORKER_ID` in `worker.env` to the label already stored in
`lane_race_events.worker_id` (check with
`SELECT DISTINCT worker_id FROM lane_race_events`) so the existing lane-race
history stays visible.
