# สถาปัตยกรรม, โครงสร้างโค้ด และเทคนิคทำให้ตอบเร็ว

เอกสารรวมทุกอย่างของโปรเจกต์นี้ในไฟล์เดียว — ระบบทำอะไร, วางโครงสร้างยังไง, โค้ดแต่ละส่วน
ทำหน้าที่อะไร, และเทคนิคที่ใช้จริงเพื่อให้ตอบข้อความใน LINE OpenChat ให้เร็วและนิ่งที่สุด

---

## 1. ภาพรวมระบบ

บอทตอบอัตโนมัติสำหรับ LINE OpenChat/กลุ่ม แบบ multi-tenant — ผู้ใช้หลายคน (`users`) แต่ละคน
เป็นเจ้าของบอทได้หลายตัว (`bots`, ผูกด้วย `owner_user_id`) บอทของเจ้าของเดียวกันตั้งใจให้อยู่
ห้องเดียวกันได้หลายตัว เพื่อ**แข่งกันตรวจจับข้อความคีย์เวิร์ดให้เร็วที่สุด** แล้วให้ตัวที่กำหนดไว้
("primary") เป็นคนตอบจริงตัวเดียว ไม่ให้ห้องเห็นคำตอบซ้อนกัน

เป้าหมายหลักของทั้งระบบ: **ตอบให้ทันหรือเร็วกว่าบอทคู่แข่งในห้องเดียวกัน** ทุกการตัดสินใจด้าน
สถาปัตยกรรมโยงกลับมาที่เป้าหมายนี้

---

## 2. สถาปัตยกรรม / Topology

```
                    ┌─────────────────────────────┐
 ผู้ใช้ (แดชบอร์ด) → │  Server 1 (AWS, edge)        │
                    │  - nginx: serve frontend      │
                    │  - reverse proxy → Server 2   │
                    │  - linebot-backend: ปิดถาวร   │
                    └───────────────┬───────────────┘
                                    │ WireGuard/private network
                                    ▼
                    ┌─────────────────────────────────────────┐
                    │  Server 2 (บอทจริงทำงานที่นี่)             │
                    │                                           │
                    │  ┌─────────────────┐  ┌─────────────────┐│
                    │  │ linebot-worker   │  │ linebot-worker-  ││
                    │  │ (process หลัก)   │  │ shard-b (opt-in) ││
                    │  │ - Hono API+WS    │  │ - เฉพาะ owner    ││
                    │  │ - บอทส่วนใหญ่     │  │   ที่ระบุ         ││
                    │  │ - core ที่ 1      │  │ - core ที่ 2      ││
                    │  └────────┬─────────┘  └────────┬─────────┘│
                    │           │  แชร์ไฟล์เดียวกัน      │          │
                    │           └──────────┬───────────┘          │
                    │                      ▼                      │
                    │           worker.db (SQLite, WAL mode)      │
                    │                      │                      │
                    │           ┌──────────┴──────────┐           │
                    │           ▼                     ▼           │
                    │   sender (Go binary)     sqlite-writer       │
                    │   loopback :4790          (worker thread)    │
                    └───────────┬───────────────────────────────┘
                                │ HTTP/2 (h2-lanes, connection pool ที่คุมเอง)
                                ▼
                        LINE OpenChat servers
```

**หลักการแบ่ง Server**: Server 1 ทำหน้าที่ edge/reverse-proxy + เสิร์ฟไฟล์ frontend อย่างเดียว
ไม่มี logic บอทเลย — Server 2 คือที่ที่บอทจริงรัน (LINE session, poll, ตอบ) Server 1/Server 2
**ไม่ใช่** load-balance กัน แต่เป็นคู่ edge/backend คนละหน้าที่

**linebot-worker กับ linebot-worker-shard-b**: process เดียวกันทุกบรรทัดโค้ด รันจาก release
เดียวกัน ต่างกันแค่ env ที่บอกว่า process ไหนดูแล owner ไหน (`WORKER_OWNER_SCOPE`/`EXCLUDE` แบบ
ระบุมือ หรือ `WORKER_ASSIGNMENT_MODE=balanced-sticky` แบบแบ่งอัตโนมัติ — ดูหัวข้อ 6) — เกิดจาก
การเจอว่า reply/poll hot path เป็น single JS thread เดียว ต่อให้เครื่องมีกี่ core ก็ใช้ได้จริงแค่
core เดียวเสมอถ้ารันแค่ process เดียว จึงแยกบอทบางส่วนไปรันอีก process เพื่อใช้ core ที่สอง

**sender (Go binary)**: relay HTTP แบบ stateless แยกจาก process หลัก ไม่รู้จัก LINE protocol เลย
แค่ยิง request ตามที่สั่ง — เหตุผลที่แยกออกมาต่างหากคือให้ Bun/Node ไม่ต้องแบกงาน I/O ระดับต่ำ
เอง และเปลี่ยน/restart ได้อิสระจาก process หลัก

---

## 3. โครงสร้างโค้ด

### 3.1 Backend (`backend/src/`, รันด้วย Bun ไม่ใช่ Node.js)

```
index.ts          จุดเริ่มโปรเซส — spawn sender, ตั้ง DISPATCH_TOKEN, เริ่ม system-load monitor,
                   import api/server.ts
config.ts          อ่าน env vars ทั้งหมด (PORT, DB_PATH, ฯลฯ) จุดเดียว

bot/                ← หัวใจของระบบ ตรรกะบอททั้งหมดอยู่ที่นี่
  session-manager.ts   ไฟล์ใหญ่สุด — start/stop บอท, login, handleIncoming (จุดตัดสินใจตอบ),
                        primary/secondary handoff, watchdog, ทุกอย่างที่เป็น "runtime" ของบอทหนึ่งตัว
  fast-square-poller.ts  loop poll เฉพาะห้อง hot (ดูหัวข้อ 7.1)
  fast-poll-room.ts      เลือกว่าห้องไหนควรได้ fast-poll (budget-based, ดูหัวข้อ 7.2)
  primary-bot.ts          ใครคือบอท "หลัก" ที่ตอบจริงในห้องหนึ่งๆ เมื่อมีบอทพี่น้องหลายตัว
  incoming-message-policy.ts  ด่านตรวจต่อข้อความ (shouldProcessIncomingMessage) — เรียก chat-access.ts + square-roles.ts
  chat-access.ts          "ที่เก็บ" enabled/admin-only/allowlist + cache ในหน่วยความจำ + setter
  reply-guard.ts          กันตอบซ้ำ (claimIncomingMessage / claimReply / claimRoomAnswer)
  reply-sender.ts / reply-defense.ts / automatic-reply-echo.ts   เลือกวิธีส่งเร็วสุด / กันคำตอบถูกลบ / กัน echo ตัวเอง
  rate-limiter.ts         sliding-window จำกัดความถี่การส่งต่อบัญชี
  rules.ts                กฎ keyword→คำตอบ, compile+cache, matchRule()
  worker-scope.ts         กำหนดว่า process นี้ดูแลบอทของ owner ไหน (ดูหัวข้อ 6)
  worker-topology.ts / worker-assignment.ts   env/JSON → owner routes + validate ตอน boot / balanced-sticky assign
  square-stall-policy.ts  ตรรกะกู้คืนแบบขั้นบันไดเมื่อ connection ดูค้าง
  square-roles.ts / square-access-policy.ts / square-poll-quiet.ts / square-visibility.ts   role/สิทธิ์/เงียบ poll/ตรวจ+ส่งซ้ำ OpenChat
  bots.ts / room-config-copy.ts / room-coverage.ts / scheduled-posts.ts / anomalies.ts / alerts.ts
                          CRUD และ helper รอบๆ บอท/ห้อง/รายงาน

dispatch/           ชั้นสื่อสารกับ LINE
  h2-lanes.ts          connection pool HTTP/2 ที่คุมเอง (ดูหัวข้อ 7.4) — หัวใจของความเร็วฝั่งส่ง + เลือก SEND lane
  lane-speed-policy.ts / send-prediction.ts   ค่าคงที่ cool/pin lane / พยากรณ์เวลา SEND เสร็จต่อ bot-route
  lane-race.ts / lane-race-persistence.ts   บันทึกผลแข่งของแต่ละ lane หลังส่งเสร็จ (ไม่บล็อกการตอบ)
  warmer.ts / prewarm-scope.ts   อุ่น connection ล่วงหน้า (scope กัน warm-up ไปตอบ traffic จริง)
  binary-protocol.ts / client.ts / direct-request.ts / prewarm-ack.ts  ชั้น request ไปยัง sender/LINE

security/           middleware จับ intrusion (login ล้ม/session ปลอม/cross-site write) → alert + dashboard event
announcements/      ประกาศแอดมินโชว์บน console ผู้ใช้ทุกคน (list เดียว เห็นจากทุก worker)

linejs-core/        LINE client library (Thrift protocol, encode/decode, auth, E2EE) — fork/
                    ปรับแต่งเฉพาะโปรเจกต์นี้ ไม่ใช่ npm package ภายนอก

api/                Hono HTTP + WebSocket server
  server.ts            ตั้ง route ทั้งหมด, /ws สำหรับ live event ไปแดชบอร์ด
  routes/bots.ts, bot-detail.ts, users.ts, auth.ts, health.ts, metrics.ts, logs.ts, confirm.ts

db/                 SQLite (bun:sqlite, WAL mode)
  schema.ts             ทุกตาราง (ดูหัวข้อ 4)
  migrations.ts          migration แบบ idempotent, รันอัตโนมัติตอน boot
  write-behind.ts + sqlite-writer.worker.ts   เขียนข้อมูลที่ไม่ใช่ hot-path ผ่าน worker thread แยก
                        กันงาน disk I/O ไปกวน thread หลักที่ต้องตอบข้อความ

metrics/            latency.ts (p50/p95/p99 ring buffer) + fast-path.ts (breakdown เวลาแต่ละ phase)
auth/               session, login-throttle, password hashing
monitoring/         system-load.ts (CPU/RAM/event-loop monitor + แจ้งเตือน)
```

### 3.2 Frontend (`frontend/src/`, React + Vite, build ด้วย Bun)

```
Dashboard.tsx        component ใหญ่สุด — state กลางทั้งหมด, WebSocket subscription, ต่อ API
pages/                หนึ่งไฟล์ต่อหนึ่งหน้าในแดชบอร์ด (ภาพรวม, บอททั้งหมด, กฎ, บันทึกสด, ผู้ใช้, ...)
components/           UI ย่อยที่ page เรียกใช้ (BotsPanel, LiveFeed, RuleEditor, ...)
lib/
  api.ts                 ทุก endpoint เรียก backend
  types.ts                type ตรงกับ backend (Bot, Rule, ChatRow, LatencySample, ...)
  group-bots.ts           จัดกลุ่มบอทพี่น้องตาม owner (ใช้ทั้งหน้าบอททั้งหมด+บันทึกสด)
  useOwnerNames.ts         ดึงชื่อ owner (admin-only) มาแทนเลข id
  useWebSocket.ts          hook ต่อ /ws รับ event สด
```

---

## 4. โมเดลข้อมูล (SQLite, ตารางหลัก)

| ตาราง | เก็บอะไร |
|---|---|
| `users` | บัญชีแอดมิน/ผู้ใช้ทั่วไป, `bot_quota` |
| `bots` | หนึ่งแถว = หนึ่งบัญชี LINE, `owner_user_id`, `status`, `slot`, `is_primary` ต่อห้อง |
| `chats` | ห้อง/กลุ่มที่บอทแต่ละตัวเป็นสมาชิก, `enabled`, `admin_only`, `is_primary` |
| `chat_admin_allowlist` | รายชื่อ admin เฉพาะที่อนุญาตให้ trigger เมื่อห้องตั้ง admin-only |
| `rules` | keyword → คำตอบ ต่อบอท (`match_type`: equals/startsWith/regex/containsAny) |
| `messages_in` | ข้อความเข้าที่บันทึกไว้ (feed + forensics) |
| `latency_samples` | ทุกครั้งที่ตอบ (จริงหรือทดสอบ), `inbound_ms`, `latency_ms`, `ok` |
| `lane_race_events` | ผลแข่งของแต่ละ H2 lane (ใช้ debug connection pool) |
| `bot_events` | เหตุการณ์บอท (login, resume, error) เพื่อดูย้อนหลัง |
| `anomalies` | เหตุการณ์ผิดปกติที่ควรมีคนดู (แยกจาก log กิจกรรมปกติ — ดูหัวข้อ 7.5) |
| `scheduled_posts` | โพสต์ตามเวลาที่ตั้งไว้ล่วงหน้า |
| `owner_worker_assignments` | balanced-sticky: owner id → worker id ที่ถูก assign (assign ครั้งเดียว ไม่ย้าย — ดูหัวข้อ 6) |
| `announcements` | ประกาศแอดมินที่โชว์บน console ผู้ใช้ |
| `kv` / `app_meta` | ค่าตั้งค่าเบ็ดเตล็ดต่อบอท / ค่า global ที่ทุก worker แชร์ (maintenance mode, square poll-quiet, restart ts) |

---

## 5. เส้นทางข้อความ — จากคนพิมพ์คีย์เวิร์ดถึงบอทตอบ

1. **ตรวจจับ (สองทางแข่งกัน)**: push ปกติของ LINE (`fetchMyEvents`, batch ~100ms) วิ่งคู่ขนานกับ
   dedicated poller เฉพาะห้อง hot (`fetchSquareChatEvents`, ไม่มีจังหวะพัก) ใครเห็นก่อนไปต่อก่อน
2. **ด่านตรวจ** (`incoming-message-policy.ts`): 1-1 talk ไม่ตอบเสมอ, ห้องต้อง enabled, square
   admin-only เช็ค role + allowlist — ทุก lookup ผ่าน `chat-access.ts` (Set/Map ในหน่วยความจำ) ไม่แตะ DB
3. **จับคู่กฎ** (`rules.ts`): เทียบข้อความกับกฎที่ compile ไว้ล่วงหน้าแล้ว
4. **กันตอบซ้ำ** (`reply-guard.ts`): กันบอทตัวเองตอบซ้ำ + กันบอทพี่น้องของ owner เดียวกันตอบซ้อนกัน
5. **Primary handoff** (`primary-bot.ts`): ถ้าบอทที่เจอไม่ใช่ตัวหลักของห้องนั้น ส่งไม้ต่อให้ตัวหลัก
   ตอบแทน (เรียกฟังก์ชันในโปรเซสเดียวกัน ต้นทุนแทบเป็นศูนย์)
6. **ส่งจริง**: ผ่าน rate-limiter → h2-lanes (เลือก connection ที่เร็วสุด ณ ตอนนั้น) → sender (Go)
7. **บันทึกผล**: `latency_samples` + ส่ง event ขึ้นแดชบอร์ดผ่าน WebSocket

รายละเอียดเต็มของแต่ละขั้น อยู่ในหัวข้อ 7 ด้านล่าง

---

## 6. ระบบแบ่งงานหลาย Process (ใช้ CPU มากกว่า 1 core)

**ปัญหาที่เจอ**: reply/poll hot path เป็น single-thread เดียว วัดจริงพบว่า process เดียวกินไป
เกือบเต็ม 1 core ตลอดเวลาแม้ไม่มีข้อความเข้า (จาก `SQUARE_FAST_POLL_INTERVAL_MS=0` ที่ยิงถี่
ไม่มีจังหวะพัก) ส่วน core ที่สองของเครื่องว่างเปล่าไม่เคยถูกใช้เลย

**ทางแก้**: รันโค้ดชุดเดิมเป็น process ที่สอง (`linebot-worker-shard-b`) แบ่งบอทตาม **owner**
ไปคนละ process — ไม่ใช่ worker_threads เพราะต้องย้าย session/token ของ LINE client ข้าม thread
ซึ่งเสี่ยงกว่ามากและแตะโค้ด auth ที่ sensitive; รัน process แยกทำให้ reuse โค้ดเดิม 100%

แบ่งบอทเข้า process ได้ 2 แบบ — `worker-topology.ts` แปลง config เป็น env ชุดนี้ตอน boot:
```
# แบบที่ 1 — static: ระบุ owner ตายตัว
WORKER_OWNER_SCOPE=2        shard: ดูแลเฉพาะ owner ที่ระบุ (comma-separated)
WORKER_OWNER_EXCLUDE=2      primary: ดูแลทุกคนยกเว้นที่ระบุ — ต้องตรงกับ WORKER_OWNER_ROUTES เป๊ะ
ไม่ตั้งเลย                   ดูแลทุกคน — พฤติกรรมเดิม 100% (ค่า default)

# แบบที่ 2 — balanced-sticky: owner ใหม่ไปฝั่งที่บอทน้อยกว่า, ไม่ย้ายทีหลัง
WORKER_ASSIGNMENT_MODE=balanced-sticky
WORKER_ASSIGNMENT_WORKERS=primary,shard-b   (ตัวแรก = primary)
```
`worker-assignment.ts` เลือก worker ให้ owner ใหม่ภายใต้ SQLite `IMMEDIATE` transaction (กัน 2
process assign พร้อมกันจาก count เดิม) เก็บผลถาวรในตาราง `owner_worker_assignments` — owner ที่
assign แล้วไม่ถูกย้ายอีก เพราะการย้ายบอทข้าม process กลางคันเสี่ยงเท่ากับกฎเหล็กด้านล่างที่ห้าม
`worker-topology.json` (ตั้ง path ที่ `WORKER_TOPOLOGY_FILE`, prod default อยู่ข้าง `DB_PATH`) คือ
ทางลัดให้ deploy user คุมทั้ง topology จากไฟล์เดียวโดยไม่ต้องแก้ root-owned EnvironmentFile

**กฎเหล็ก**: ห้ามแบ่งบอทของ owner เดียวกันข้าม process เด็ดขาด เพราะมี state ในหน่วยความจำที่
ใช้ร่วมกันเฉพาะบอทของ owner เดียวกัน (ต้องอยู่ process เดียวกันเท่านั้นถึงจะถูก):
- `roomAnswers` ใน reply-guard.ts (กันบอทพี่น้องตอบซ้ำห้องเดียวกัน)
- primary/secondary handoff ใน session-manager.ts (`runtimes.get(primaryBotId)` หาข้าม process
  ไม่เจอ จะ fallback ไปส่งด้วยตัวเองแทนแบบเงียบๆ)
- sibling fast-poll nudge ใน `syncFastSquarePollers`

ส่วนที่ปลอดภัย แยก process ได้โดยไม่ต้องแก้อะไร: h2-lanes (key ด้วย origin ไม่เกี่ยวบอท),
SQLite (WAL mode + busy_timeout รองรับ multi-writer อยู่แล้ว), rate-limiter (key ด้วย botId ล้วนๆ)

**Safety rail ที่เพิ่มไว้**: `startBot()`/`stopBot()`/`enforceBotQuota()` เช็ค `inWorkerScope()`
ก่อนทำงานเสมอ — กันบอทถูกสั่ง start/stop ผิด process โดยไม่ตั้งใจ (จะทำให้ login ซ้อนสองบัญชี
เดียวกัน หรือเขียนทับสถานะบอทของ process อื่นที่กำลังรันอยู่จริง) นอกจากนั้น
`validateWorkerTopology()` รันตอน boot บังคับให้ split สมบูรณ์ (EXCLUDE ตรงกับ ROUTES,
balanced-sticky ห้ามปน static scope, CONTROL_PLANE_TOKEN ≥32 ตัว ฯลฯ) — ถ้าไม่ครบ process ตาย
ตั้งแต่ boot ดีกว่าปล่อยให้ catch-all กับ shard login บัญชีเดียวกันพร้อมกันเงียบๆ

---

## 7. เทคนิคทำให้ตอบเร็วและนิ่ง

หลักการรวมข้อเดียวที่คุมทุกอย่างข้างล่างนี้: **แยกให้ชัดว่าเวลาไหนคุมได้ เวลาไหนคุมไม่ได้ แล้ว
ทุ่มความพยายามเฉพาะส่วนที่คุมได้** — เวลาที่ LINE ใช้ส่ง event มาถึงเรา (`inbound_ms`) ต่อให้
โค้ดเราดีแค่ไหนก็แก้ไม่ได้ อย่าไปเสียเวลาตรงนั้น วัดจริงพบว่า inbound_ms กินสัดส่วนใหญ่ของเวลา
ทั้งหมด (มักเกิน 60-80%) ส่วนที่เราคุมได้ (decrypt+จับคู่กฎ+เช็คสิทธิ์+เตรียมส่ง) รวมกันเหลือแค่
หลัก ms เดียว

### 7.1 Dedicated Room Poller สำหรับห้อง hot
1 async loop ต่อ `bot + ห้อง` พร้อม sync token ของตัวเอง เรียก `fetchSquareChatEvents` ตรงถึงห้อง
บน connection ที่อุ่นอยู่แล้ว `interval=0` หมายถึงเริ่มรอบถัดไปทันทีหลังได้ผลตอบกลับ (ไม่ใช่ยิง
ซ้อนกัน) — เร็วกว่า push ปกติของ LINE ที่ batch ไว้ ~100ms มาก แลกมาด้วย CPU ที่กินต่อเนื่อง
(ดูหัวข้อ 6 สำหรับทางแก้)

### 7.2 Budget ห้อง ไม่ใช่จัดอันดับ
จำกัดจำนวนห้องที่ fast-poll ต่อบอท (`SQUARE_FAST_POLL_MAX_ROOMS`) — **กับดักที่เจอจริง**: ถ้า
เลือกห้องด้วยการจัดอันดับความคึกคักที่ผ่านมา ห้องที่ปกติเงียบแต่บางครั้งสำคัญมากจะไม่มีวันติด
อันดับก่อนข้อความนั้นจะมาถึง (ไก่กับไข่) **ทางแก้**: ผูก `MAX_SQUARE_CHATS_PER_BOT` (จำนวนห้อง
ที่เปิดใช้งานได้) ให้เท่ากับโควตา fast-poll พอดีในโค้ดจริง (ไม่ใช่แค่คอมเมนต์เตือน) ผลคือทุกห้อง
ที่เปิดไว้ได้ poll ครบเสมอ ไม่ต้องแข่งอันดับกันเลย

### 7.3 บอทพี่น้องแข่งตรวจจับ ตอบทีเดียว
บอทของ owner เดียวกันหลายตัวอยู่ห้องเดียวกันได้ (จังหวะ poll ต่างกันคนละมิลลิวินาที) เพิ่มโอกาส
เจอข้อความเร็วสุดในฝูง — ตัวที่เจอก่อนและ claim ได้ก่อนส่งไม้ต่อให้ "ตัวหลัก" ที่กำหนดไว้ตอบจริง
(เรียกฟังก์ชันในโปรเซสเดียวกัน ต้นทุนแทบเป็นศูนย์ ดูหัวข้อ 5.5) ผลคือห้องเห็นผู้ตอบคนเดียวเสมอ
แม้เบื้องหลังจะมีหลายบัญชีช่วยตรวจจับ — **สำคัญ**: rate-limit ต้องผูกกับบัญชีที่ส่งจริง ไม่ใช่
บัญชีที่ตรวจจับ ไม่งั้นบัญชีตัวจริงโดนเร่งเกินโควตาโดยไม่มีอะไรเช็คทัน (เจอจริง: บอทพี่น้องที่
ไม่มีกฎเลยสักข้อ ตรวจจับได้แต่ไม่มีทางตอบเอง ต้องก็อปกฎจากตัวหลักมาให้ครบก่อนถึงจะช่วยแข่งได้จริง)

### 7.4 HTTP/2 Connection Pool ที่คุมเอง (`h2-lanes.ts`)
ไม่ใช้ default fetch pool — สร้าง pool เอง (6-10 lane ต่อ origin) เลือก lane จาก RTT/สถานะ/
in-flight ที่วัดจริง ไม่ปล่อยให้ library เลือกแบบสุ่ม แยกเลนสำหรับ "ส่ง" ออกจากเลนสำหรับ
"ตรวจจับ" ได้ (`LINE_H2_SEND_RESERVED_LANES`) เพราะ poll รัวๆ แย่งเลนกับตอนต้องส่งจริง (วัดจริง:
16.6ms → 35.5ms ตอนไม่แยก) แต่ต้องวัดผลจริงก่อนคงค่าไว้ถาวร ไม่ใช่ทุกค่าที่ "ดูน่าจะช่วย" จะช่วยจริง

การเลือก SEND lane (`lane-speed-policy.ts` + `send-prediction.ts`, รายละเอียดเต็มใน
`PROJECT-BLUEPRINT.md` 7.4): พยากรณ์เวลาเสร็จต่อ bot-route ด้วย `p50 + jitter×0.35 + queueMs`
(7-sample), cool lane ที่ช้ากว่า `SEND_SLOW_FLOOR_MS=23` หรือ 1.5× ตัวที่เร็วสุดในรอบ (fail-open
ถ้าทุก lane ช้าหมด), จำ lane ที่บอทเคยวัดต่ำกว่า 21ms ไว้ชนะ *เฉพาะ tie จริง* (hysteresis 21/23),
จัดอันดับ cold lane ด้วย median RTT ต่อ Akamai IP, รีไซเคิล lane ทุก ~15 นาที — ทุกค่ามาจาก
incident จริง (`SEND_SLOW_FLOOR_MS` เคยลองลด 23→20 แล้วพังภายใน 1 ชม.) ต้อง A/B test ทีละค่า

### 7.5 Hot path ทำงานจาก memory ล้วนๆ
กฎ compile+cache ไว้ล่วงหน้า, สิทธิ์ห้อง/allowlist lookup จาก Map, claim/dedupe เป็น Map แบบ TTL
— ไม่มีจุดไหนใน hot path รอ database ก่อนตอบ sync กับฐานข้อมูลเฉพาะตอนมีการแก้ config เท่านั้น

### 7.6 ป้องกันการค้างแบบเงียบๆ
ทุก fetch ห่อด้วย timeout (`Promise.race` กับตัวจับเวลา) — connection ที่ค้างแบบไม่ error คือ
สาเหตุจริงของอาการ "ห้องเงียบไปดื้อๆ 20+ นาที ทั้งที่ระบบดูออนไลน์ปกติ" watchdog เช็คเป็นระยะว่า
เงียบนานผิดปกติไหม ไม่ใช่รอ error โผล่มาเอง กู้คืนแบบขั้นบันได (ลองเบาสุดก่อน ค่อยยกระดับ)
พร้อม cooldown กันยิงซ้ำรัว

### 7.7 วินัยการวัดผล
- วัด "เวลาที่แข่งกับคู่แข่งจริง" = inbound (LINE ส่งช้าแค่ไหน) + เวลาที่เราตอบ ไม่ใช่แค่ครึ่งหลัง
- ห้ามสรุปจากช่วงเวลาเดียว — latency แกว่งเองตามธรรมชาติ 20-60ms+ ต้องเทียบแบบสลับช่วง (A/B/A/B)
  อย่างน้อย 50+ ตัวอย่างจาก 3+ ช่วงเวลาที่ไม่ติดกัน — ทีมนี้เคยพลาดมาแล้ว 2 ครั้งจากการเชื่อผล
  ช่วงเดียว
- เก็บ timestamp จากนาฬิกา LINE เอง (ไม่ใช่นาฬิกาเรา) ทั้งข้อความเข้าและข้อความตอบ — เทียบความ
  เร็วกับคู่แข่งได้ตรงๆ โดยไม่ต้องรู้อะไรเกี่ยวกับระบบของคู่แข่งเลย (คำตอบของคู่แข่งก็เป็นแค่
  "ข้อความเข้า" ธรรมดาที่มี timestamp ชนิดเดียวกัน)

### 7.8 บทเรียน/กับดักที่เจอมาจริง
1. "ยิ่งขนานเยอะยิ่งเร็ว" ไม่จริงเสมอไปเมื่อทรัพยากรที่ใช้ร่วมกันมีจำกัด — วัดก่อนเชื่อ
2. Connection ที่ค้างแบบไม่ error คือของจริง ต้องมี timeout ทุกจุดที่รอผลจากภายนอก
3. ค่าคงที่สองตัวที่ต้องเท่ากันเพื่อให้ระบบถูกต้อง ต้องผูกกันในโค้ดจริง ไม่ใช่แค่คอมเมนต์เตือนกัน
4. Log วินิจฉัย (`[SQ_DIAG]`) ที่ตั้งใจให้ "เปิดตลอด" เพราะดูไม่แพง อาจสะสมจนกิน CPU/ท่วม log
   จนดึงย้อนหลังไม่ได้จริงเมื่อรันนานๆ — ควรมีทางปิด/ลดความถี่แยกจาก debug flag หลัก
5. **กฎที่ปิดอยู่ (`enabled=0`) คือสาเหตุ "ไม่ตอบ" ที่พบบ่อยที่สุด ไม่ใช่ความเร็ว** — ก่อนไล่ debug
   เรื่องเวลา ให้เช็คก่อนว่ามีกฎที่ enabled จริงที่ตรงกับคำที่คนพิมพ์จริงหรือไม่ (คำใกล้เคียงแต่
   ไม่ตรงเป๊ะ เช่น "เข้าไดเลย" vs กฎ "เข้าเลย" ก็นับว่าไม่ตรงเช่นกัน — `containsAny` ต้องเป็น
   substring ต่อเนื่องเป๊ะ ไม่ใช่ fuzzy match)
6. บอทพี่น้องที่ไม่มีกฎเลย ตรวจจับได้แต่ตอบเองไม่ได้ — ต้องก็อปกฎจากบอทหลักมาให้ (มีฟีเจอร์
   `copyRoomConfig` ไว้ให้แล้ว ไม่ต้องพิมพ์ใหม่ทีละบอท)

---

## 8. Deploy

- Server 1 (frontend/edge): `deploy-server1.sh` — build frontend, publish ผ่าน nginx,
  `linebot-backend` ต้องปิดตลอด (Server 2 คือคนเสิร์ฟ API จริง)
- Server 2 (backend/บอท): `deploy-server2.sh` — cross-compile sender (Go) ในเครื่อง deploy,
  รัน `bun test` เต็มชุดบนเซิร์ฟเวอร์ก่อนสลับ symlink, restart `linebot-worker` +
  `linebot-worker-shard-b` (ถ้าเปิดใช้งานอยู่) แบบ best-effort
- Blue-green ด้วย symlink — สลับกลับได้ทันทีถ้าพัง, บันทึก rollback target ไว้เป็นขั้นแรกสุด
- Restart ทำให้ latency ช้าลงชั่วคราว ~15-20 นาที (connection pool ต้องอุ่นใหม่) แล้วกลับมานิ่ง
  เองโดยไม่ต้องทำอะไรเพิ่ม — ไม่ใช่ bug

รายละเอียด environment variables ทั้งหมด (template ไม่ใช่ค่าจริง) ดูที่ `SPEED-TECHNIQUES.md`
หัวข้อ 8
