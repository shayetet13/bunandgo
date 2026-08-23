# Session Handoff — Per-Bot Predicted Fastest Lane

อัปเดตล่าสุด: 2026-08-23 (Asia/Bangkok)

## 1. เป้าหมายของผู้ใช้

แก้โปรเจกต์ LINE bot ให้ทุก bot วิ่งผ่าน lane ที่คาดว่าจะส่งเสร็จเร็วที่สุด โดยมีเป้าหมาย SEND RTT ต่ำกว่า `20ms` และใช้ `23ms` เป็น slow-route guardrail พร้อมข้อกำหนดต่อไปนี้:

- Bot และ LINE session ต้องอยู่ Primary/Shard B ตาม owner เดิม ห้ามสลับเมื่อ login ใหม่
- Server 3 ต้องเป็น lane relay เท่านั้น ห้ามมี bot, login, token store หรือฐานข้อมูลผู้ใช้
- Primary และ Shard B ต้องใช้ทั้ง local lanes บน Server 2 และ relay lanes บน Server 3
- ห้ามส่งข้อความซ้ำเพื่อ race หลาย lane; หนึ่งข้อความออกเพียงหนึ่ง server/หนึ่ง physical lane
- ทุก physical lane ต้อง warm/ready แต่ไม่บังคับให้งานจริงกระจายเท่ากัน เพราะจะทำให้งานไป lane ช้า
- Soft affinity เท่ากับ `0.1ms`
- ต้อง commit ก่อน deploy และต้องมี rollback
- เป้าหมายต่ำกว่า `20ms` เป็น SLO/ความคาดหวัง ไม่ใช่คำรับประกัน network ภายนอกของ LINE/Akamai

## 2. Git baseline ก่อนเริ่มแก้รอบนี้

สร้าง checkpoint แล้ว:

```text
fb3c8dc chore: checkpoint before lane scheduler rewrite
```

Commit ก่อนหน้า:

```text
70aa106 fix: route every bot through the fastest SEND lane
e164a0a fix: enforce LINE name lock during live sessions
482807b perf: tighten lane switch margin to 0.1ms
```

Checkpoint `fb3c8dc` เป็น empty commit เพราะ worktree สะอาดและทุกไฟล์อยู่ใน `70aa106` แล้ว จุดนี้ใช้ย้อนกลับก่อน predicted-lane rewrite ได้ชัดเจน

## 3. Production ก่อนเริ่มแก้รอบนี้

โค้ด predicted-lane ที่อธิบายในเอกสารนี้ **ยังไม่ได้ deploy**

Production รอบก่อนหน้าที่ตรวจผ่าน:

- Server 2 release: `/opt/linebot/releases/20260823-071858-deploy`
- Server 3 release: `/opt/linebot-relay/releases/20260823-071818-70aa106`
- Primary: active
- Shard B: active
- Server 3 lane relay: active
- Server 3 origin: `https://legy.line-apps.com`
- Server 3 lanes: `32/32 ready`
- Primary topology: local 16 + relay 32
- Shard B topology: local 16 + relay 32
- Production topology backup: `/opt/linebot/shared/worker-topology.before-fastest-20260823-071758.json`

หลัง deploy รอบก่อนยังไม่มี SEND sample ใหม่ จึงยังไม่มีข้อมูล production ที่พิสูจน์ว่า RTT ต่ำกว่า 20ms หลัง commit `70aa106`

## 4. สาเหตุที่พบใน selector เดิม

โค้ดเดิมมีข้อจำกัดสำคัญ:

1. Preferred SEND affinity ผูกด้วย `origin` เพียงอย่างเดียว ทำให้ bot ทั้ง worker แชร์ preferred lane เดียวกัน
2. SEND median ใช้เพียง 3 samples จึงมอง p95/jitter spike ไม่ชัด
3. Global cooldown จาก bot หนึ่งสามารถมีผลกับ bot อื่น
4. `inFlight` ใช้เป็น tie-break เท่านั้นและไม่มีข้อมูล HTTP/2 capacity จริง
5. Routing ไม่มี stable bot route key จึงสร้างสถิติ `bot × lane` ไม่ได้
6. Internal routing header อาจหลุดไป upstream หาก owned lane ใช้ไม่ได้และ fallback ไป native fetch

## 5. การแก้ไขที่อยู่ใน worktree ตอนนี้

การแก้ทั้งหมดด้านล่างยัง **ไม่ได้ commit** และ **ไม่ได้ deploy**

### 5.1 โมดูล prediction ใหม่

เพิ่มไฟล์:

- `backend/src/dispatch/send-prediction.ts`
- `backend/src/dispatch/send-prediction.test.ts`

สูตรปัจจุบัน:

```text
predicted completion = p50 + (p95 - p50) × 0.35 + queue waves × p50
```

รายละเอียด:

- ใช้ SEND window 7 samples เพื่อเห็น spike
- queue cost เกิดเฉพาะเมื่อ `inFlight` ชน `maxConcurrentStreams` ที่ HTTP/2 peer ประกาศจริง
- ไม่ใช้ penalty เดาแบบ `inFlight × 4ms`
- Per-bot profile หมดอายุหลัง 30 วินาทีแล้ว fallback ไป lane shared prior
- Per-bot profile จำกัด 2,048 keys ต่อ physical lane และ evict แบบ least-recently-used insertion order
- Raw SEND มากกว่า 23ms ทำให้ bot-route นั้น cooldown 15 วินาที
- SEND เร็วครั้งถัดไปล้าง cooldown ทันที

Environment defaults ใหม่:

```text
LINE_H2_SEND_SAMPLE_WINDOW=7
LINE_H2_SEND_ROUTE_SAMPLE_MAX_AGE_MS=30000
LINE_H2_SEND_JITTER_WEIGHT=0.35
LINE_H2_MAX_SEND_ROUTE_PROFILES=2048
```

### 5.2 Per-bot routing key

แก้:

- `backend/src/bot/session-manager.ts`
- `backend/src/dispatch/client.ts`
- `backend/src/dispatch/h2-lanes.ts`
- `backend/src/relay/dispatch-route.ts`

`session-manager.ts` ส่ง `botId` เข้า `createDispatchFetch(...)` เป็น stable route key

Internal header:

```text
x-linebot-lane-route-key
```

ข้อควรยืนยัน:

- Header นี้ใช้ระหว่าง process/Server 2/Server 3 เท่านั้น
- `buildHeaders()` ถอด header ก่อนส่ง LINE
- Native-fetch fallback บน Server 2 ถอดทั้ง role และ route-key header
- Native-fetch fallback บน Server 3 ถอดทั้ง role และ route-key header
- Test ยืนยันว่า route key ไม่รั่วไป direct upstream แล้ว

### 5.3 Local physical lane prediction

แก้ `backend/src/dispatch/h2-lanes.ts`:

- Affinity key เปลี่ยนจาก `origin` เป็น `origin + bot route key`
- Lane เก็บ per-bot SEND profile
- Lane อ่าน `remoteSettings.maxConcurrentStreams`
- เลือก lane จาก predicted completion ต่อ bot
- Jittery lane สามารถแพ้ stable lane แม้ median ต่ำกว่า
- Per-bot cooldown ไม่ควร poison bot อื่น
- Soft affinity ยังใช้ margin `0.1ms`
- Reconnect ล้าง sample/profile ของ physical connection เดิม
- GOAWAY/dead ล้าง affinity เฉพาะ key ที่ชี้ lane นั้น

### 5.4 Server 3 virtual candidate

แก้ `backend/src/dispatch/remote-lane.ts`:

- เก็บ full Server 2 → Server 3 → LINE SEND history แยกต่อ bot route key
- Remote candidate ใช้ per-bot p50/p95 samples เมื่อมี
- Remote cooldown แยกต่อ bot
- ถ้ายังไม่มี per-bot sample ใช้ shared/report prior เพื่อ bootstrap
- Server 3 ยังไม่เก็บ login/bot/database และยังส่งเพียงหนึ่ง request ต่อข้อความ

### 5.5 Direct transport bug ที่แก้ร่วมกัน

เส้นทาง `createDispatchFetch()` ที่รับ `Request` เคยเรียก `fetchLineDirect(request)` โดยไม่ได้แปลง method/body เข้า `RequestInit` ที่ owned lane ใช้ การแก้ปัจจุบันอ่าน body หนึ่งครั้งแล้วส่ง method/headers/body/signal ให้ direct hot path อย่างชัดเจน

## 6. ไฟล์ที่แก้และยังไม่ commit

```text
M  backend/src/bot/session-manager.ts
M  backend/src/dispatch/client.ts
M  backend/src/dispatch/direct-fetch.test.ts
M  backend/src/dispatch/h2-lanes.test.ts
M  backend/src/dispatch/h2-lanes.ts
M  backend/src/dispatch/remote-lane.test.ts
M  backend/src/dispatch/remote-lane.ts
M  backend/src/relay/dispatch-route.ts
?? backend/src/dispatch/send-prediction.test.ts
?? backend/src/dispatch/send-prediction.ts
?? SESSION-HANDOFF-FASTEST-LANE.md
```

ห้าม discard/reset ไฟล์เหล่านี้ เพราะเป็น implementation ที่กำลังทำต่อจาก checkpoint

## 7. ผลตรวจล่าสุด

รันหลังการแก้ล่าสุดแล้ว:

```text
bun run typecheck
ผล: ผ่าน
```

Focused tests:

```text
bun test \
  src/dispatch/send-prediction.test.ts \
  src/dispatch/h2-lanes.test.ts \
  src/dispatch/remote-lane.test.ts \
  src/dispatch/direct-fetch.test.ts \
  src/relay \
  src/api/lane-relay-events.test.ts

ผล: 91 pass, 0 fail, 197 expect
```

สิ่งที่ test แล้ว:

- Per-bot lane A/B เลือกคนละผู้ชนะได้
- Bot หนึ่ง cooldown ไม่ตัด lane ของทุก bot
- Stable 17ms ชนะ median 15ms ที่ spike ถึง 48ms
- Queue penalty เกิดเมื่อชน HTTP/2 capacity จริงเท่านั้น
- Soft affinity 0.1ms ยังทำงาน
- Local/remote SEND และ POLL ไม่ปนคะแนน
- Remote end-to-end history แยกต่อ bot
- Internal route key ไม่รั่วไป native upstream
- Exactly-one-send และ body integrity เดิมยังผ่าน
- GOAWAY, abort, reconnect, prime และ relay report tests ยังผ่าน

ยังไม่ได้รันหลังแก้รอบนี้:

- Full `bun test`
- `bun run lint`
- `bunx prettier --check .`
- `git diff --check`
- Production benchmark/canary

Full suite ก่อนเริ่มแก้รอบนี้เคยผ่าน `542 pass, 0 fail` แต่ต้องรันใหม่เพราะมี implementation ใหม่แล้ว

## 8. งานที่ต้องทำต่อในเซสชันใหม่

ทำตามลำดับนี้:

1. อ่าน diff ทุกไฟล์ โดยเฉพาะ `h2-lanes.ts`, `remote-lane.ts`, `client.ts`
2. ตรวจ `shouldPreferRemoteLane()` อีกครั้งสำหรับกรณี local/remote cooldown ต่อ bot และกรณีทุก route cooling
3. เพิ่ม test กรณี local กับ remote มี cooldown ต่างกันสำหรับ bot A/B
4. ตรวจว่า Go transport rollback path ยังคงรับ method/body/role ถูกต้อง
5. ตรวจว่า route key ไม่มีทางถูกส่งถึง LINE ทุก fallback path
6. ตรวจ allocation ใน SEND hot path; ห้ามสร้าง Map/JSON เพิ่มโดยไม่จำเป็น
7. อัปเดตเอกสารที่ยังเขียนว่า median 3 และ inFlight tie-only:
   - `NETWORK-LANE-RACE.md`
   - `LINE-BOT-LATENCY-PLAYBOOK.md`
   - `deploy/server2/README.md`
   - `README.md` หากมีสูตรเดิม
8. รัน full validation
9. ตรวจ `git diff` และ dead code
10. Commit implementation ก่อน deploy
11. Deploy Server 3 ก่อน เพราะ relay bundle/schema ต้องรองรับโค้ดใหม่
12. ตรวจ Server 3 health ให้ ready ครบทุก lane
13. Deploy Server 2
14. ตรวจ Primary/Shard B active, login owner ไม่เปลี่ยน, ไม่มี duplicate/reconnect loop
15. อ่าน SEND metrics จริงหลังมี traffic โดยแยก per bot/p50/p95/p99

## 9. Full validation ที่ต้องผ่านก่อน commit/deploy

จาก `backend/`:

```powershell
bun test
bun run typecheck
bun run lint
bunx prettier --check .
```

จาก repository root:

```powershell
git diff --check
git status --short
```

ถ้า Prettier ไม่ผ่าน ให้ใช้ formatter เฉพาะไฟล์ที่แก้ แล้วรัน check ใหม่ ห้าม rewrite ไฟล์ unrelated

## 10. Commit/deploy policy

ห้าม deploy worktree ที่ยังไม่ commit

Commit ที่แนะนำหลัง full validation:

```text
perf: predict the fastest SEND lane per bot
```

Deploy order:

```text
commit
→ deploy Server 3
→ verify relay health/readiness
→ deploy Server 2
→ verify Primary + Shard B
→ inspect logs and real SEND metrics
```

Server 3 deploy script:

```text
deploy-server3.sh
```

Server 2 deploy script:

```text
deploy-server2.sh
```

ทั้งสอง script มี safety/health flow เดิมอยู่แล้ว อย่าข้าม rollback target

## 11. Acceptance criteria

Correctness ที่ต้องบังคับได้:

- Selector เลือก predicted completion ต่ำที่สุดต่อ bot
- Bot owner/login ไม่ย้าย
- Server 3 ไม่มี bot/login/database
- หนึ่งข้อความส่งครั้งเดียว
- Duplicate = 0
- Lost message จาก selector = 0
- Internal route header ไม่ถึง LINE
- Slow bot ไม่ poison lane choice ของ bot อื่น
- Jittery route ถูกลดอันดับหรือ cooldown
- เมื่อทุก route ช้า ระบบ fail-open ไป route ที่ predicted ต่ำสุด ไม่ทิ้งข้อความ

Performance target:

- Internal routing p95 เป้าหมาย `<1ms`
- SEND RTT ต่อ bot p50 เป้าหมาย `<20ms`
- SEND RTT ต่อ bot p95 เป้าหมาย `≤23ms` เมื่อเส้นทาง LINE/Akamai รองรับ

ห้ามรายงานว่า “รับประกันทุกข้อความต่ำกว่า 20/23ms” เพราะระบบควบคุม LINE/Akamai ภายนอกไม่ได้ สิ่งที่รับประกันได้คือ selector policy, cooldown, exactly-once route decision และ internal overhead budget

## 12. คำสั่งเริ่มต้นสำหรับเซสชันใหม่

```text
อ่าน SESSION-HANDOFF-FASTEST-LANE.md ให้ครบ แล้วทำงานต่อจาก uncommitted worktree ปัจจุบัน ห้าม reset/discard งานเดิม ตรวจ code/diff, เพิ่ม test ที่ขาด, อัปเดต docs, รัน full validation, commit ก่อน deploy แล้ว deploy Server 3 ก่อน Server 2 โดยห้ามแตะ owner/login และห้ามเพิ่ม bot บน Server 3
```
