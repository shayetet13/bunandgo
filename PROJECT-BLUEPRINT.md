# Project Blueprint — สรุปเต็มสำหรับสร้างระบบใหม่

เอกสารนี้รวมทุกอย่างที่ต้องรู้เพื่อ **สร้างระบบนี้ขึ้นใหม่ให้เบากว่าเดิมและไม่เละ** — เทค
สแต็กที่ใช้จริง, ขนาดโค้ดจริงแยกตามส่วน (เพื่อรู้ว่าอะไรคือของหนักที่ไม่จำเป็นต้องแบกไปด้วย),
สถาปัตยกรรม, เทคนิคทำให้ตอบเร็วทั้งหมดที่พิสูจน์แล้วว่าได้ผลจริงจากการวัดผลจริง, กับดักที่เคย
เจอมาแล้ว (รวมของใหม่ที่เพิ่งเจอวันนี้), และคำแนะนำตรงๆ ว่าตอนสร้างใหม่ควรเก็บอะไร/ตัดอะไร

อ้างอิงเสริม (มีรายละเอียดลึกกว่าในบางหัวข้อ): [ARCHITECTURE.md](ARCHITECTURE.md),
[SPEED-TECHNIQUES.md](SPEED-TECHNIQUES.md), [DEPLOY-README.md](DEPLOY-README.md)

---

## 0. โปรเจกต์นี้คืออะไร

บอทตอบอัตโนมัติสำหรับ LINE OpenChat/กลุ่ม แบบ multi-tenant — ผู้ใช้หลายคนเป็นเจ้าของบอทได้
หลายตัว บอทของเจ้าของเดียวกันอยู่ห้องเดียวกันได้หลายตัวเพื่อ **แข่งกันตรวจจับข้อความคีย์เวิร์ด
ให้เร็วที่สุด** แล้วให้ตัวที่กำหนดไว้ ("primary") เป็นคนตอบจริงตัวเดียว

**เป้าหมายเดียวที่ทุกการตัดสินใจทางสถาปัตยกรรมโยงกลับมา**: ตอบให้ทันหรือเร็วกว่าบอทคู่แข่ง
ในห้องเดียวกัน — ไม่ใช่ "เร็วที่สุดเท่าที่จะเป็นไปได้" แบบไม่มีบริบท

---

## 1. Tech Stack แบบละเอียด

### 1.1 Backend — `backend/`

| ส่วน | เลือกใช้ | เหตุผล |
|---|---|---|
| Runtime | **Bun** (ไม่ใช่ Node.js) | `bun:sqlite` in-process ไม่ต้อง native addon, startup เร็วกว่า, รัน `.ts` ตรงไม่ต้อง build step |
| ภาษา | TypeScript (strict) | `tsc --noEmit` เป็น type-check เท่านั้น — Bun รัน source ตรงๆ ไม่มี compile step แยกใน production |
| HTTP/WS framework | **Hono** (`hono@^4`) | เบา ไม่มี dependency tree ใหญ่ ใช้กับทั้ง REST API และ `/ws` |
| Database | **`bun:sqlite`** (built-in) WAL mode | ไม่มี ORM — query ตรงๆ, prepared statements, multi-process (primary+shard) เขียนพร้อมกันได้ด้วย `busy_timeout` |
| LINE protocol | `linejs-core/` — **fork ในโปรเจกต์เอง** ไม่ใช่ npm package | ต้องปรับ transport/timing ระดับ byte เพื่อความเร็ว, ไม่มี npm package ไหนเปิดช่องให้แก้ระดับนี้ |
| Thrift wire format | `thrift@^0.24.0` (ใช้บางส่วน) + reader/writer เขียนเอง | LINE ใช้ Compact Protocol ของ Thrift |
| Crypto (E2EE) | `@noble/ciphers`, `tweetnacl`, `curve25519-js`, `crypto-js` | ทำ LINE E2EE ที่ต้อง Curve25519 + AES เอง |
| Validation | `zod@^4` | validate request body ฝั่ง API |
| Utility เฉพาะ Thrift | `node-bignumber`, `node-int64` | เลข 64-bit ที่ JS number ปกติแทนไม่ได้แม่นยำ |
| Lint/format | ESLint (flat config, `typescript-eslint`) + Prettier | — |
| Test | `bun test` (built-in, ไม่มี Jest/Vitest) | เร็ว, ไม่มี config แยก |

**ของที่ไม่มีและตั้งใจไม่มี**: ไม่มี ORM, ไม่มี dependency-injection framework, ไม่มี message
queue ภายนอก (Redis/RabbitMQ), ไม่มี process manager ภายนอก (ใช้ systemd ตรงๆ) — hot path
ต้องเบาที่สุด ทุก dependency ที่เพิ่มคือความเสี่ยงต่อ cold-start/GC/latency variance

### 1.2 Sender — `backend/sender/` (Go)

| ส่วน | เลือกใช้ |
|---|---|
| ภาษา | Go 1.26, **standard library ล้วนๆ — ไม่มี external dependency แม้แต่ตัวเดียว** (`go.mod` ไม่มี `require` เลย) |
| หน้าที่ | stateless HTTP relay, loopback `:4790`, ไม่รู้จัก LINE protocol เลย แค่ยิง request ตามที่สั่ง |
| Build | cross-compile จากเครื่อง deploy (`GOOS=linux GOARCH=amd64`) — เซิร์ฟเวอร์ปลายทางไม่มี Go toolchain เลย ต้องได้ binary สำเร็จรูปมาเท่านั้น |

**เหตุผลที่แยกเป็น process ภาษาอื่นแทนทำใน Bun**: Go จัดการ connection pooling ระดับ OS/
socket ได้ดีกว่า และแยก process ทำให้รีสตาร์ท/แก้ตัวรับส่งได้อิสระจาก process หลักที่ถือ LINE
session อยู่

### 1.3 Frontend — `frontend/`

| ส่วน | เลือกใช้ | เหตุผล |
|---|---|---|
| Framework | React 18 (ไม่ใช่ Next.js — เป็น SPA ล้วนๆ) | ไม่ต้องการ SSR, เป็น dashboard ภายใน |
| Build tool | Vite 6 | dev server เร็ว, build เบา |
| State management | **ไม่มี library แยก** — `useState`/`useEffect`/context ธรรมดา | ขนาดแอปไม่ใหญ่พอจะคุ้มกับ Redux/Zustand |
| Realtime | `useWebSocket.ts` hook ต่อ `/ws` เอง (ไม่มี socket.io) | ฝั่ง server เป็น Hono WS ธรรมดา ไม่ต้องการ protocol เพิ่ม |
| UI components | เขียนเอง ทั้งหมด (ไม่มี shadcn/MUI/Ant) | คุมขนาด bundle เอง |
| อื่นๆ | `qrcode` (แสดง QR ตอน login บอท) | จำเป็นเฉพาะฟีเจอร์เดียว |

Dependency รวมทั้งแอป (dependencies จริง ไม่รวม devDependencies): **`react`, `react-dom`,
`qrcode`** — 3 ตัวเท่านั้น นี่คือสาเหตุที่ frontend เบามาก (ดูหัวข้อ 2)

### 1.4 Infra / Deploy

| ส่วน | ใช้ | รายละเอียด |
|---|---|---|
| Server 1 (edge) | AWS EC2, nginx | serve frontend static + reverse proxy `/api`, `/ws` ไป Server 2 |
| Server 2 (บอทจริง) | Linode/Akamai VM | รัน `linebot-worker` (+ `linebot-worker-shard-b` เสริม core ที่ 2) |
| เชื่อมสองเซิร์ฟเวอร์ | WireGuard (private network, `10.77.0.0/24`) | ไม่ผ่าน public internet ระหว่าง edge↔backend |
| Process manager | systemd units ตรงๆ | ไม่มี PM2/Docker — `sudo` scope แคบมาก (คำสั่งเป๊ะๆ ต่อ unit เท่านั้น) |
| Deploy | shell script + `git archive HEAD` + blue-green symlink | ดูหัวข้อ 12 |
| Secrets | `/etc/linebot/*.env` (root-owned, นอก release directory) | release เป็น immutable code เท่านั้น ไม่ปนกับ config ที่มี secret |

---

## 2. ขนาดโค้ดจริง แยกตามส่วน — รู้ก่อนว่าอะไร "หนัก" จริงๆ

วัดจริงจาก repo วันนี้ (2026-08-12):

| ส่วน | ไฟล์ | บรรทัด | สัดส่วน |
|---|---|---|---|
| **`linejs-core/types/`** (Thrift type ที่ generate มา) | 3 ไฟล์ | **60,944** | 57% ของ backend ทั้งหมด |
| `linejs-core/base/` (protocol client เขียนมือ) | 87 ไฟล์ | 26,644 | 25% |
| `linejs-core/client/` (public API surface) | 16 ไฟล์ | 2,973 | 3% |
| **`bot/`** (ตรรกะบอทจริง — หัวใจของแอป) | 65 ไฟล์ | 9,283 | 9% |
| `dispatch/` (H2 lanes, warmer) | 17 ไฟล์ | 2,392 | 2% |
| `api/` (Hono routes) | 19 ไฟล์ | 2,583 | 2% |
| `db/`, `metrics/`, `auth/`, `monitoring/` | 21 ไฟล์ | 2,316 | 2% |
| **รวม backend** | **230 ไฟล์** | **107,280** | 100% |
| **frontend ทั้งหมด** | 57 ไฟล์ | 7,101 | — |

**ข้อสรุปที่สำคัญที่สุดของหัวข้อนี้**: backend "107,280 บรรทัด" ฟังดูใหญ่มาก แต่ **84% (91,561
บรรทัด) คือ LINE protocol client ที่ generate/เขียนครั้งเดียวแล้วแทบไม่แตะอีก** — โดยเฉพาะ
`types/` 60,944 บรรทัดคือ Thrift struct ที่ generate มาจาก schema ของ LINE ไม่ใช่โค้ดที่คนเขียน
มือทีละบรรทัด ส่วนที่เป็น **ตรรกะแอปจริงที่ทีมดูแล/แก้บ่อย มีแค่ ~16,574 บรรทัด** (`bot/` +
`dispatch/` + `api/` + `db/`+`metrics/`+`auth/`+`monitoring/`)

**ถ้าจะสร้างใหม่ให้ "เบา"**: อย่าตัดสินใจว่าโปรเจกต์นี้ใหญ่/เละจากยอดรวม 107K บรรทัด — ให้แยก
protocol layer (generate ได้, แตะน้อย) ออกจาก app layer (เขียนมือ, แตะบ่อย, ต้อง clean) ตั้งแต่
วันแรก แล้ววัดความ "เละ" เฉพาะฝั่ง app layer เท่านั้น (ดูหัวข้อ 15)

---

## 3. สถาปัตยกรรม / Topology

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

- Server 1 = edge/reverse-proxy + เสิร์ฟ frontend เท่านั้น ไม่มี logic บอท
- Server 2 = ที่ที่บอทจริงรัน (LINE session, poll, ตอบ)
- ทั้งสองเซิร์ฟเวอร์ **ไม่ใช่** load-balance กัน แต่เป็นคู่ edge/backend คนละหน้าที่กันขาด

### 3.1 ทำไมต้องแยก process เป็น 2 ตัวบน Server 2 เดียว

reply/poll hot path เป็น **single JS thread เดียว** — ต่อให้เครื่องมีกี่ core ก็ใช้ได้จริงแค่ core
เดียวถ้ารันแค่ process เดียว (วัดจริง: process เดียวกิน CPU เกือบเต็ม 1 core ตลอดเวลาแม้ไม่มี
ข้อความเข้า เพราะ fast-poll ยิงรัวไม่มีจังหวะพัก) → รันโค้ดชุดเดิมเป็น process ที่สอง
(`linebot-worker-shard-b`) แบ่งบอทตาม **owner** ไปคนละ process

**ทำไมไม่ใช้ `worker_threads`**: ต้องย้าย LINE session/token ข้าม thread ซึ่งเสี่ยงกว่ามากและแตะ
โค้ด auth ที่ sensitive — รัน process แยกแทนทำให้ reuse โค้ดเดิม 100% ไม่ต้องคิดเรื่อง
thread-safety ของ client library เลย

**กฎเหล็ก**: ห้ามแบ่งบอทของ owner เดียวกันข้าม process เด็ดขาด เพราะมี state ในหน่วยความจำที่
ใช้ร่วมกันเฉพาะบอทของ owner เดียวกัน (`roomAnswers` กันตอบซ้ำ, primary/secondary handoff,
sibling fast-poll nudge) — ต้องอยู่ process เดียวกันเท่านั้นถึงจะถูก

```
WORKER_OWNER_SCOPE=2        process นี้ดูแลเฉพาะ owner ที่ระบุ (ใช้กับ shard ใหม่)
WORKER_OWNER_EXCLUDE=2      process นี้ดูแลทุกคนยกเว้นที่ระบุ (ใช้กับ process หลัก/catch-all)
ไม่ตั้งทั้งคู่                ดูแลทุกคน — พฤติกรรมเดิม (ค่า default)
```

ส่วนที่ปลอดภัยแยก process ได้โดยไม่ต้องแก้อะไร: h2-lanes (key ด้วย origin ไม่เกี่ยวบอท), SQLite
(WAL mode + `busy_timeout` รองรับ multi-writer อยู่แล้ว), rate-limiter (key ด้วย botId ล้วนๆ)

**Safety rail**: `startBot()`/`stopBot()`/`enforceBotQuota()` เช็ค `inWorkerScope()` ก่อนทำงาน
เสมอ กันบอทถูกสั่ง start/stop ผิด process โดยไม่ตั้งใจ

⚠️ **สถานะจริงตอนนี้ (2026-08-12)**: shard-b **active อยู่บนเซิร์ฟเวอร์จริง** (`WORKER_OWNER_SCOPE=2`)
แต่ primary env **ยังไม่ได้ตั้ง** `WORKER_OWNER_EXCLUDE=2`/`WORKER_OWNER_ROUTES` — สภาพนี้เสี่ยงที่
owner 2 จะถูกรันซ้อนสอง process พร้อมกัน (ดูหัวข้อ 14.3) เป็นตัวอย่างจริงของ "งานทำค้างครึ่งๆ
กลางๆ" ที่หัวข้อ 15 พูดถึง — ก่อน deploy อะไรที่แตะ owner scope ต้องปิด gap นี้ก่อน

---

## 4. โครงสร้างโค้ด (backend/src/)

```
index.ts          จุดเริ่มโปรเซส — spawn sender, ตั้ง DISPATCH_TOKEN, เริ่ม system-load monitor
config.ts          อ่าน env vars ทั้งหมดจุดเดียว

bot/                ← หัวใจของระบบ ตรรกะบอททั้งหมดอยู่ที่นี่ (9,283 บรรทัด)
  session-manager.ts   ไฟล์ใหญ่สุด — start/stop บอท, login, handleIncoming, primary/secondary
                        handoff, watchdog
  fast-square-poller.ts  loop poll เฉพาะห้อง hot
  fast-poll-room.ts      เลือกว่าห้องไหนควรได้ fast-poll (budget-based)
  primary-bot.ts          ใครคือบอท "หลัก" ที่ตอบจริงในห้องหนึ่งๆ
  reply-guard.ts          กันตอบซ้ำ (claimIncomingMessage / claimReply / claimRoomAnswer)
  rate-limiter.ts         sliding-window จำกัดความถี่การส่งต่อบัญชี
  chat-access.ts          ห้องไหนเปิดตอบ/admin-only/allowlist — cache ในหน่วยความจำ
  rules.ts                กฎ keyword→คำตอบ, compile+cache, matchRule()
  worker-scope.ts         กำหนดว่า process นี้ดูแลบอทของ owner ไหน
  square-stall-policy.ts  ตรรกะกู้คืนแบบขั้นบันไดเมื่อ connection ดูค้าง
  square-visibility.ts    flag เปิด/ปิดการตรวจ+ส่งซ้ำข้อความที่ส่งไปแล้วไม่โชว์ในห้อง (ตรวจจริงใน square-forensics.ts)
  bots.ts / room-config-copy.ts / room-coverage.ts / scheduled-posts.ts / anomalies.ts / alerts.ts

dispatch/           ชั้นสื่อสารกับ LINE (2,392 บรรทัด)
  h2-lanes.ts          connection pool HTTP/2 ที่คุมเอง — หัวใจของความเร็วฝั่งส่ง
  warmer.ts             อุ่น connection ล่วงหน้า
  client.ts / direct-request.ts / prewarm-ack.ts

linejs-core/        LINE client library (fork, ไม่ใช่ npm package ภายนอก) — ดูหัวข้อ 2

api/                Hono HTTP + WebSocket server (2,583 บรรทัด)
  server.ts            ตั้ง route ทั้งหมด, /ws สำหรับ live event
  routes/bots.ts, bot-detail.ts, users.ts, auth.ts, health.ts, metrics.ts, logs.ts, confirm.ts

db/                 SQLite (bun:sqlite, WAL mode)
  schema.ts / migrations.ts (idempotent, รันอัตโนมัติตอน boot)
  write-behind.ts + sqlite-writer.worker.ts   เขียนข้อมูล non-hot-path ผ่าน worker thread แยก

metrics/            latency.ts (p50/p95/p99 ring buffer) + fast-path.ts (breakdown เวลาแต่ละ phase)
auth/               session, login-throttle, password hashing
monitoring/         system-load.ts (CPU/RAM/event-loop monitor + แจ้งเตือน)
```

### Frontend (`frontend/src/`)

```
Dashboard.tsx        component ใหญ่สุด — state กลาง, WebSocket subscription, ต่อ API
pages/                หนึ่งไฟล์ต่อหนึ่งหน้า (ภาพรวม, บอททั้งหมด, กฎ, บันทึกสด, ผู้ใช้, ...)
components/           UI ย่อย (BotsPanel, LiveFeed, RuleEditor, LatencyBreakdown, ...)
lib/
  api.ts / types.ts / group-bots.ts / useOwnerNames.ts / useWebSocket.ts / live-feed-metrics.ts
```

---

## 5. โมเดลข้อมูล (SQLite)

| ตาราง | เก็บอะไร |
|---|---|
| `users` | บัญชีแอดมิน/ผู้ใช้ทั่วไป, `bot_quota` |
| `bots` | หนึ่งแถว = หนึ่งบัญชี LINE, `owner_user_id`, `status`, `slot` |
| `chats` | ห้อง/กลุ่มที่บอทแต่ละตัวเป็นสมาชิก, `enabled`, `admin_only`, `is_primary` |
| `chat_admin_allowlist` | รายชื่อ admin เฉพาะที่อนุญาตให้ trigger เมื่อห้องตั้ง admin-only |
| `rules` | keyword → คำตอบ ต่อบอท (`match_type`: equals/startsWith/regex/containsAny) |
| `messages_in` | ข้อความเข้าที่บันทึกไว้ (feed + forensics) |
| `latency_samples` | ทุกครั้งที่ตอบ, `inbound_ms`, `latency_ms`, breakdown ทุกช่วง, `ok` |
| `lane_race_events` | ผลแข่งของแต่ละ H2 lane (debug connection pool) |
| `bot_events` | เหตุการณ์บอท (login, resume, error) |
| `anomalies` | เหตุการณ์ผิดปกติที่ควรมีคนดู แยกจาก log กิจกรรมปกติ |
| `scheduled_posts` | โพสต์ตามเวลาที่ตั้งไว้ล่วงหน้า |
| `auth_sessions` | session token ของผู้ใช้แดชบอร์ด |
| `kv` | ค่าตั้งค่าเบ็ดเตล็ดต่อบอท |

ไม่มี ORM — ทุก query เขียนด้วย `bun:sqlite` prepared statement ตรงๆ

---

## 6. เส้นทางข้อความ — จากคนพิมพ์คีย์เวิร์ดถึงบอทตอบ

1. **ตรวจจับ (หลายทางแข่งกัน)**: push ปกติของ LINE (`fetchMyEvents`, batch ~100ms) วิ่งคู่ขนาน
   กับ dedicated poller เฉพาะห้อง hot (`fetchSquareChatEvents`, ไม่มีจังหวะพักหรือเว้น 100ms
   แล้วแต่ config) — ใครเห็นก่อนไปต่อก่อน ทุก event เข้า handler เดิม ไม่มี code path พิเศษ
2. **ด่านตรวจ** (`chat-access.ts`): ห้องเปิดตอบไหม/admin-only ไหม/อยู่ allowlist ไหม — เช็คจาก
   Map ในหน่วยความจำล้วนๆ ไม่แตะฐานข้อมูล
3. **จับคู่กฎ** (`rules.ts`): เทียบข้อความกับกฎที่ compile ไว้ล่วงหน้าแล้ว
4. **กันตอบซ้ำ** (`reply-guard.ts`): กันบอทตัวเองตอบซ้ำ + กันบอทพี่น้องของ owner เดียวกันตอบซ้อน
5. **Primary handoff** (`primary-bot.ts`): ถ้าบอทที่เจอไม่ใช่ตัวหลักของห้องนั้น ส่งไม้ต่อให้ตัว
   หลักตอบแทน (function call ในโปรเซสเดียวกัน ต้นทุนแทบเป็นศูนย์)
6. **ส่งจริง**: rate-limiter → h2-lanes (เลือก connection ที่เร็วสุด ณ ตอนนั้น) → sender (Go)
7. **บันทึกผล**: `latency_samples` + ส่ง event ขึ้นแดชบอร์ดผ่าน WebSocket (async, ไม่บล็อกการตอบ)

---

## 7. เทคนิคทำให้ตอบเร็ว (พิสูจน์แล้วจากการวัดผลจริง)

หลักการรวม: **แยกให้ชัดว่าเวลาไหนคุมได้ เวลาไหนคุมไม่ได้ แล้วทุ่มความพยายามเฉพาะส่วนที่คุมได้**
— วัดจริงพบว่า `inbound_ms` (เวลาที่ LINE ใช้ส่ง event มาถึงเรา) กินสัดส่วนใหญ่ของเวลาทั้งหมด
(มักเกิน 60-80%) ต่อให้โค้ดเราดีแค่ไหนก็แก้ตรงนี้ไม่ได้ ส่วนที่เราคุมได้ (decrypt+จับคู่กฎ+เช็ค
สิทธิ์+เตรียมส่ง) รวมกันเหลือแค่หลัก ms เดียว

### 7.1 Dedicated Room Poller สำหรับห้อง hot
1 async loop ต่อ `bot + ห้อง` พร้อม sync token ของตัวเอง เรียก `fetchSquareChatEvents` ตรงถึง
ห้องบน connection ที่อุ่นอยู่แล้ว — เร็วกว่า push ปกติของ LINE ที่ batch ไว้ ~100ms มาก แลกมาด้วย
CPU ที่กินต่อเนื่อง (ดูหัวข้อ 3.1 สำหรับทางแก้)

### 7.2 Budget ห้อง ไม่ใช่จัดอันดับ
จำกัดจำนวนห้องที่ fast-poll ต่อบอท (`SQUARE_FAST_POLL_MAX_ROOMS`) — **กับดักที่เจอจริง**: ถ้า
เลือกห้องด้วยการจัดอันดับความคึกคักที่ผ่านมา ห้องที่ปกติเงียบแต่บางครั้งสำคัญมากจะไม่มีวันติด
อันดับก่อนข้อความนั้นจะมาถึง (ไก่กับไข่) **ทางแก้**: ผูก `MAX_SQUARE_CHATS_PER_BOT` (จำนวนห้อง
ที่เปิดใช้งานได้) ให้เท่ากับโควตา fast-poll พอดี**ในโค้ดจริง** (ไม่ใช่แค่คอมเมนต์เตือน) ผลคือทุก
ห้องที่เปิดไว้ได้ poll ครบเสมอ ไม่ต้องแข่งอันดับกันเลย

### 7.3 บอทพี่น้องแข่งตรวจจับ ตอบทีเดียว
บอทของ owner เดียวกันหลายตัวอยู่ห้องเดียวกันได้ (จังหวะ poll ต่างกันคนละมิลลิวินาที) เพิ่มโอกาส
เจอข้อความเร็วสุดในฝูง — ตัวที่เจอก่อนและ claim ได้ก่อนส่งไม้ต่อให้ "ตัวหลัก" ตอบจริง ผลคือห้อง
เห็นผู้ตอบคนเดียวเสมอ แม้เบื้องหลังจะมีหลายบัญชีช่วยตรวจจับ

**สำคัญ**: rate-limit ต้องผูกกับบัญชีที่ส่งจริง ไม่ใช่บัญชีที่ตรวจจับ ไม่งั้นบัญชีตัวจริงโดนเร่ง
เกินโควตาโดยไม่มีอะไรเช็คทัน และบอทพี่น้องที่ไม่มีกฎเลยสักข้อ ตรวจจับได้แต่ตอบเองไม่ได้ — ต้อง
ก็อปกฎจากตัวหลักมาให้ครบก่อนถึงจะช่วยแข่งได้จริง (`copyRoomConfig`)

### 7.4 HTTP/2 Connection Pool ที่คุมเอง (`h2-lanes.ts`)
ไม่ใช้ default fetch pool — สร้าง pool เอง (6-10 lane ต่อ origin) เลือก lane จาก RTT/สถานะ/
in-flight ที่วัดจริง แยกเลนสำหรับ "ส่ง" ออกจากเลนสำหรับ "ตรวจจับ" ได้
(`LINE_H2_SEND_RESERVED_LANES`) เพราะ poll รัวๆ แย่งเลนกับตอนต้องส่งจริง (วัดจริง: 16.6ms →
35.5ms ตอนไม่แยก) — **แต่ต้องวัดผลจริงก่อนคงค่าไว้ถาวร ไม่ใช่ทุกค่าที่ "ดูน่าจะช่วย" จะช่วยจริง**

### 7.5 Hot path ทำงานจาก memory ล้วนๆ
กฎ compile+cache ไว้ล่วงหน้า, สิทธิ์ห้อง/allowlist lookup จาก Map, claim/dedupe เป็น Map แบบ TTL
— ไม่มีจุดไหนใน hot path รอ database ก่อนตอบ sync กับฐานข้อมูลเฉพาะตอนมีการแก้ config เท่านั้น

### 7.6 ป้องกันการค้างแบบเงียบๆ
ทุก fetch ห่อด้วย timeout (`Promise.race` กับตัวจับเวลา) — connection ที่ค้างแบบไม่ error คือ
สาเหตุจริงของอาการ "ห้องเงียบไปดื้อๆ 20+ นาที ทั้งที่ระบบดูออนไลน์ปกติ" watchdog เช็คเป็นระยะว่า
เงียบนานผิดปกติไหม ไม่ใช่รอ error โผล่มาเอง กู้คืนแบบขั้นบันได พร้อม cooldown กันยิงซ้ำรัว

### 7.7 ใช้ protocol แบบกระชับที่สุดที่ปลายทางรองรับ
ถ้าปลายทางมี "แบบเต็ม" กับ "แบบย่อ" ของ request เดียวกัน ใช้แบบย่อเสมอเมื่อทำได้ ลดเวลา
serialize/transfer ต่อ request

---

## 8. เทคนิคความนิ่ง/ทนทาน (Reliability)

### 8.1 Watchdog เช็คเป็นระยะ ไม่ใช่รอ error
timer แยกเช็คว่า "เงียบมานานผิดปกติหรือยัง" (เทียบกับเวลาล่าสุดที่มีกิจกรรม) แทนรอ error โผล่มา
เอง — connection ที่ค้างแบบไม่ error คือของจริงที่เจอบ่อยที่สุด

### 8.2 กู้คืนแบบขั้นบันได
1. ลองซ่อมแบบเบาที่สุดก่อน (ยิง request ใหม่บน connection เดิม)
2. ถ้าไม่หาย ปิด connection ให้ตัวเองต่อใหม่
3. ถ้ายังไม่หายหลายรอบ ถึงจะรื้อ session ทั้งหมด (แพงที่สุด ใช้เป็นทางเลือกสุดท้าย)

แต่ละขั้นมี cooldown กันยิงซ้ำรัว และต้อง**เช็คให้แน่ใจว่าการซ่อมรอบก่อนเกิดขึ้นจริง**ก่อนนับ
cooldown

### 8.3 ผูกค่าคงที่ที่ต้องสอดคล้องกันไว้ด้วยกันจริงๆ ในโค้ด
ถ้ามีค่าคงที่สองตัวคนละที่ในโค้ดที่ "บังเอิญ" ต้องเท่ากันเพื่อให้ระบบทำงานถูก **อย่าปล่อยให้
บังเอิญตรงกัน** — ให้ตัวหนึ่งอ้างอิงมาจากอีกตัวโดยตรงในโค้ด แล้วเขียน test ล็อกไว้ว่าต้องเท่ากัน
เสมอ (ดูหัวข้อ 14.1 — บั๊กจริงที่เจอเพราะไม่ทำแบบนี้)

### 8.4 Log เหตุการณ์ผิดปกติแยกจาก log กิจกรรมปกติ
เหตุการณ์ที่ควรมีคนมาดู (ส่งไม่สำเร็จ, ช้าผิดปกติ, connection ค้าง) ต้องแยกตาราง/ช่องทางจาก log
กิจกรรมทั่วไป ไม่งั้นจะจมหายไปในปริมาณ log ปกติ

### 8.5 Multi-process safety rail
ทุกจุดที่แก้ state ของบอท (start/stop/quota) ต้องเช็คก่อนว่า process นี้มีสิทธิ์ดูแลบอทตัวนั้น
จริงไหม (`inWorkerScope()`) — ป้องกัน 2 process แย่งกันคุมบอทเดียวกัน ซึ่งทำให้ login ซ้อนสอง
บัญชีเดียวกัน (LINE ตอบ `NOT_AUTHORIZED_DEVICE` วนไม่จบ — ดูหัวข้อ 14.3)

---

## 9. วินัยการวัดผล

1. **วัด "เวลาที่แข่งกับคู่แข่งจริง"** = inbound (LINE ส่งช้าแค่ไหน) + เวลาที่เราตอบ ไม่ใช่แค่
   ครึ่งหลัง บอทที่ตอบใน 20ms แต่รู้ตัวช้าไป 80ms แพ้บอทที่ตอบ 50ms แต่รู้ตัวตรงเวลา
2. **ห้ามสรุปจากช่วงเวลาเดียว** — latency แกว่งเองตามธรรมชาติ 20-60ms+ ต้องเทียบแบบสลับช่วง
   (A/B/A/B) อย่างน้อย 50+ ตัวอย่างจาก 3+ ช่วงเวลาที่ไม่ติดกัน (ทีมนี้เคยพลาดมาแล้ว 2 ครั้งจาก
   การเชื่อผลช่วงเดียว)
3. **เก็บ timestamp จากนาฬิกา LINE เอง** (ไม่ใช่นาฬิกาเรา) ทั้งข้อความเข้าและข้อความตอบ —
   เทียบความเร็วกับคู่แข่งได้ตรงๆ โดยไม่ต้องรู้อะไรเกี่ยวกับระบบของคู่แข่งเลย
4. **ระวัง metric ที่เทียบนาฬิกาคนละอันโดยไม่รู้ตัว** — ดูหัวข้อ 14.2 (กับดักจริงที่เพิ่งเจอ)

---

## 10. Multi-tenant / การแบ่งสิทธิ์

- `dev`/platform-owner สร้างบัญชีเจ้าของ (`users`), กำหนดโควตาบอท (`bot_quota`)
- เจ้าของหนึ่งคนมีบอทได้หลายตัว ผูกด้วย `owner_user_id`
- ห้อง (`chats`) ต่อบอทมี flag `enabled`/`admin_only`/`is_primary` แยกกัน — ห้องเดียวกันเปิด/ปิด
  ได้ต่างกันในแต่ละบอทของ owner เดียวกัน
- `chat_admin_allowlist` จำกัดว่าใครใน LINE ห้องนั้น trigger บอทได้ เมื่อตั้ง admin-only

---

## 11. Dashboard (Frontend)

- Login แยก 3 ระดับ (ตามที่ระบบวางแผนไว้ — ดู [[online-reflective-curry]] ถ้ามี auth overhaul
  เพิ่มเติม): dev (platform owner), admin (shop/เจ้าของบอท), user ทั่วไป
- Realtime ผ่าน `/ws` — ทุก `send_result`, `chats_updated`, `anomaly` ฯลฯ ส่งขึ้น dashboard ทันที
  ไม่ผ่าน polling
- **Dashboard/API ต้องไม่กวน hot path เด็ดขาด** — เขียน metrics/log ผ่าน worker thread แยก
  (`sqlite-writer.worker.ts`) ไม่บล็อก event loop หลักที่ต้องตอบข้อความ

---

## 12. Deploy Pipeline

- **Server 1** (`deploy-server1.sh`): build frontend, publish ผ่าน nginx, `linebot-backend` ต้อง
  ปิดตลอด (Server 2 คือคนเสิร์ฟ API จริง)
- **Server 2** (`deploy-server2.sh`):
  1. บันทึก rollback target ไว้เป็นขั้นแรกสุด (ก่อนอะไรจะพังได้)
  2. `git archive --format=tar.gz -o deploy.tar.gz HEAD` — **แพ็กจาก commit ที่ระบุแน่นอนเท่านั้น
     ไม่ใช่ working directory ที่แก้ค้างอยู่** (เตือนถ้ามี uncommitted changes)
  3. cross-compile sender (Go) ในเครื่อง deploy เอง (ปลายทางไม่มี Go toolchain)
  4. upload → extract เป็น release directory ใหม่ (`/opt/linebot/releases/<ts>-deploy`)
  5. **verify ว่า `.env` ไม่ได้ติดไปกับ release** (secret ต้องอยู่นอก release เสมอ)
  6. `bun install --production` + **รัน test suite เต็มชุดบนเซิร์ฟเวอร์ก่อนสลับ symlink** — ถ้า
     test พังห้ามสลับ ของเดิมยังทำงานต่อได้ปกติ
  7. validate ว่า worker scope ของ primary/shard ไม่ทับซ้อนกัน (ดูหัวข้อ 3.1 gap ที่เจอ)
  8. สลับ symlink (blue-green) → restart service → health check → **rollback อัตโนมัติ**ถ้า
     service ไม่ขึ้นภายในเวลาที่กำหนด

Restart ทำให้ latency ช้าลงชั่วคราว ~15-20 นาที (connection pool ต้องอุ่นใหม่) แล้วกลับมานิ่งเอง
— ไม่ใช่ bug แต่เป็นต้นทุนที่ต้องรู้ล่วงหน้าก่อนตัดสินใจ restart ตอน production กำลังยุ่ง

---

## 13. Environment Variables — รายการเต็ม (ชื่อจริงในโค้ด)

```bash
# ===== Fast-poll =====
SQUARE_FAST_POLL=1
SQUARE_FAST_POLL_INTERVAL_MS=100          # 0 = ยิงถี่สุดที่ round-trip อนุญาต
SQUARE_FAST_POLL_ALLOW_50MS=0             # เปิดเฉพาะ shard ที่แยก isolate แล้วเท่านั้น
SQUARE_FAST_POLL_MAX_ROOMS=1              # ต้อง <= MAX_SQUARE_CHATS_PER_BOT เสมอ (ผูกในโค้ด)
SQUARE_FAST_POLL_WORKERS=1                # cap เป็น 1 เสมอในโค้ด ห้าม > 1
SQUARE_FAST_POLL_INITIAL_DRAIN_LIMIT=10
SQUARE_FAST_POLL_FETCH_TIMEOUT_MS=15000
SQUARE_FAST_POLL_ACTIVITY_WINDOW_MS=900000
SQUARE_FAST_POLL_RESELECT_INTERVAL_MS=60000

# ===== Push/long-poll watchdog =====
SQUARE_IDLE_DELAY_MS=20
SQUARE_STALL_MS=8000
SQUARE_STALL_RECOVERY_COOLDOWN_MS=15000
SQUARE_STALL_ESCALATE_AFTER=3

# ===== HTTP/2 connection pool =====
LINE_TRANSPORT=hybrid
LINE_H2_LANES=6-8
LINE_H2_SEND_RESERVED_LANES=0             # 0 = ปิด ต้องวัดผลจริงก่อนเปิด

# ===== Reply verify/defense =====
SQUARE_VERIFY_SENDS=1
SQUARE_VERIFY_DELAY_MS=1200
SQUARE_RESEND_WHEN_INVISIBLE=1
REPLY_DEFENSE_MAX_RESENDS=3
SEND_MIN_INTERVAL_MS=0

# ===== System load monitor =====
SYSTEM_CPU_LIMIT_PERCENT=80
SYSTEM_MEMORY_LIMIT_PERCENT=80
SYSTEM_EVENT_LOOP_LIMIT_MS=100
SYSTEM_MONITOR_INTERVAL_MS=5000
SYSTEM_ALERT_SUSTAINED_SAMPLES=3
SYSTEM_ALERT_RECOVERY_SAMPLES=3

# ===== เซิร์ฟเวอร์ =====
PORT=8791
DB_PATH=./data/app.db

# ===== ความช้าที่ยอมรับได้ก่อนแจ้งเตือน =====
INBOUND_SLOW_MS=400

# ===== กันตอบซ้ำ =====
REPLY_CLAIM_TTL_MS=600000
REPLY_CLAIM_MAX=50000

# ===== ป้องกัน regex อันตราย/ข้อความยาวเกิน =====
RULE_REGEX_MAX_PATTERN=512
RULE_MATCH_MAX_TEXT=4096
RULE_REPLY_MAX_TEXT=4096

# ===== Multi-process sharding =====
WORKER_OWNER_SCOPE=            # shard: ดูแลเฉพาะ owner id ที่ระบุ (comma-separated)
WORKER_OWNER_EXCLUDE=          # primary: ดูแลทุกคนยกเว้นที่ระบุ — ต้อง sync กับทุก shard's SCOPE
WORKER_OWNER_ROUTES=           # primary: ownerId=http://127.0.0.1:port ไปยัง shard ที่ดูแล owner นั้น
CONTROL_PLANE_URL=             # shard เท่านั้น: ชี้กลับไป primary loopback port
CONTROL_PLANE_TOKEN=           # 32+ ตัวอักษร ต้องเหมือนกันทั้ง primary และทุก shard

# ===== Internal process auth =====
DISPATCH_TOKEN=                # สุ่มใหม่เอง ห้าม copy จากระบบอื่น

# ===== Auth แดชบอร์ด =====
ADMIN_USERNAME=
ADMIN_PASSWORD=

# ===== แจ้งเตือนนอกช่องทางหลัก (ถ้ามี) =====
ALERT_TELEGRAM_BOT_TOKEN=
ALERT_TELEGRAM_CHAT_ID=
```

---

## 14. บทเรียน/กับดักที่เจอมาจริง (รวมของใหม่จากวันนี้)

### 14.1 ค่าคงที่สองตัวที่ต้องเท่ากัน ต้องผูกกันในโค้ดจริง
`SQUARE_FAST_POLL_MAX_ROOMS` กับจำนวนห้องที่เปิดใช้งานได้ต่อบอทต้องเท่ากันพอดี ผูกไว้ในโค้ด
ไม่ใช่แค่คอมเมนต์เตือนกัน — ไม่งั้นบั๊กกลับมาแบบเงียบๆ ตอนมีคนแก้ค่าใดค่าหนึ่งทีหลังโดยไม่รู้ว่า
มันผูกกัน

### 14.2 [ใหม่] Dashboard metric ที่เทียบนาฬิกาคนละอันโดยไม่รู้ตัว
`LiveFeed` แสดงเลข `latencyMs` บนข้อความ "ออก" (เวลาที่โค้ดเราใช้ส่งเอง, `lineMs+codeMs`) กับเลข
`answerMs` บนข้อความ "เข้า" (ช่วงห่างระหว่าง `createdTime` ของ LINE กับข้อความเข้าก่อนหน้าใน
ห้องเดียวกัน, ดู `measureAnswers()` ใน `live-feed-metrics.ts`) **สองเลขนี้ไม่ใช่หน่วยวัดเดียวกัน**
— เลขแรกไม่รวมเวลาที่ข้อความรอ**ก่อน**โค้ดเราจะเริ่มทำงาน (`inbound_ms`) เลยที่สอง**นับ**เวลานั้น
รวมด้วย ผลคือดูจอแล้วอาจเข้าใจผิดว่า "เราเร็วกว่า" (25ms < 50ms) ทั้งที่จริงตอบช้ากว่าตามนาฬิกา
LINE เอง (ต้องกาง `inbound_ms` + `latencyMs` ของฝั่งเราเทียบกับ `createdTime` ของคู่แข่งจริงๆ ถึง
จะเห็นภาพถูก) **ทางแก้ตอนสร้างใหม่**: ถ้าจะโชว์ "ใครตอบก่อนใคร" บน dashboard เดียวกัน ให้ใช้
หน่วยวัดเดียวกันทั้งสองฝั่งเสมอ (นับจาก `createdTime` ของ trigger ล่าสุดในห้อง ไม่ใช่ผสมเลขคนละ
ที่มา) — ไม่งั้น dashboard เองจะกลายเป็นเหตุผลที่ debug ผิดทาง

### 14.3 [ใหม่] Wire protocol มีขนาด id จำกัด — ตัวนับที่ไม่ prune คือระเบิดเวลา
`ConnManager.buildAndSendSignOnRequest()` เดิมสร้าง request id ด้วย
`Object.keys(this.signOnRequests).length + 1` และไม่เคยลบ entry เก่าออกเลย แต่ wire protocol
(`conn.ts`) สงวนไว้แค่ **15 บิต** สำหรับ id (บิตที่ 16 ใช้เป็น flag `isFin`) — บน connection ที่มี
อายุนานพอ (เจอจริงภายใน < 1 ชั่วโมงบนบอทที่ห้องคึกคัก) ตัวนับทะลุ 32768 แล้ว id ใหม่ไปชนกับ
entry เก่าที่ยังค้างอยู่ซึ่งเป็นคนละชนิด request กัน → response ของ endpoint หนึ่งถูก parse ด้วย
logic ของอีก endpoint → crash แบบเงียบ ๆ และ re-arm loop ตายไปเลยจนกว่าจะมีการรื้อ session ใหม่
(อาการที่เห็น: บอทตกไปพึ่ง poll แทน push อย่างถาวร, latency ขึ้นเรื่อยๆ)

**บทเรียนทั่วไป (ใช้ได้กับทุก wire protocol ที่มี id field)**: (1) id generator ต้อง wrap ให้พอดี
กับขนาด field บน wire จริง ไม่ใช่แค่ "ตัวเลขที่นับไปเรื่อยๆ" (2) entry ที่ผูกกับ id ต้องถูกลบทันที
ที่ใช้เสร็จ ไม่ปล่อยให้ค้างจนวันหนึ่งถูก alias โดยไม่ตั้งใจ — สองข้อนี้ต้องคิดตั้งแต่ตอนออกแบบ
request/response tracking ใหม่ ไม่ใช่แพตช์ทีหลังตอนเจอ production incident

### 14.4 กฎที่ปิดอยู่คือสาเหตุ "ไม่ตอบ" ที่พบบ่อยที่สุด ไม่ใช่ความเร็ว
ก่อนไล่ debug เรื่องเวลา ให้เช็คก่อนว่ามีกฎที่ `enabled` จริงที่ตรงกับคำที่คนพิมพ์จริงหรือไม่ —
`containsAny` ต้องเป็น substring ต่อเนื่องเป๊ะ ไม่ใช่ fuzzy match ("เข้าไดเลย" ไม่ตรงกฎ "เข้าเลย")

### 14.5 Log วินิจฉัยที่ตั้งใจให้ "เปิดตลอด" อาจกิน CPU/ท่วม log จนดึงย้อนหลังไม่ได้จริง
ควรมีทางปิด/ลดความถี่แยกจาก debug flag หลักตั้งแต่ต้น

### 14.6 "ยิ่งขนานเยอะยิ่งเร็ว" ไม่จริงเสมอไปเมื่อทรัพยากรที่ใช้ร่วมกันมีจำกัด
วัดจริงแล้วว่าเพิ่ม concurrent stream จาก 1 เป็น 2 บน connection pool เดียวกันทำให้ช้าลงเท่าตัว
ไม่ใช่เร็วขึ้น — วัดก่อนเชื่อเสมอ

---

## 15. ข้อเสนอแนะสำหรับตอนสร้างใหม่ให้ "ไม่เละและเบา"

### สิ่งที่ควรเก็บไว้เหมือนเดิม (พิสูจน์แล้วว่าได้ผลจริง)
- Dedicated room poller + push แข่งกันแบบมี dedupe (หัวข้อ 7.1, 7.6)
- Primary/secondary handoff ในโปรเซสเดียวกัน (หัวข้อ 7.3)
- H2 lane pool ที่คุมเอง แยกเลนส่ง/เลนตรวจจับ (หัวข้อ 7.4) — แต่ A/B test ทุกค่าใหม่จริงๆ
- Hot path ทำงานจาก memory ล้วนๆ ไม่รอ DB/dashboard (หัวข้อ 7.5, 11)
- Watchdog เชิงรุก + กู้คืนแบบขั้นบันได (หัวข้อ 8.1-8.2)
- Blue-green deploy พร้อม auto-rollback + test gate ก่อนสลับ symlink (หัวข้อ 12)
- แยก sender (I/O ดิบ) ออกจาก process ที่ถือ session — ทำให้ restart/แก้อิสระจากกัน

### สิ่งที่ควรทำต่างจากเดิมเพื่อให้เบาและไม่เละ

1. **แยก protocol layer ออกจาก app layer ตั้งแต่วันแรก เป็นคนละแพ็กเกจ/โฟลเดอร์ชัดเจน** —
   จากหัวข้อ 2: 84% ของบรรทัดทั้งหมดคือ LINE protocol client ที่ generate/แตะน้อย ถ้าแยกเป็น
   internal package ที่มี boundary ชัด (ไม่ import ตรรกะแอปกลับเข้ามา) การวัด "โค้ดเละไหม" จะทำ
   ได้แม่นยำขึ้นมาก เพราะดูแค่ ~16.5K บรรทัดของ app layer พอ ไม่ต้องปนกับของที่ไม่ได้แตะอยู่แล้ว

2. **ห้ามปล่อยฟีเจอร์ค้างครึ่งๆ กลางๆ ใน production config** — shard-b (หัวข้อ 3.1) เป็นตัวอย่าง
   จริงของปัญหานี้: โค้ด validate เข้มงวดมาก แต่ env จริงบนเซิร์ฟเวอร์ตั้งไม่ครบ ทำให้ deploy ปกติ
   ใช้งานไม่ได้ ทั้งที่ไม่เกี่ยวกับ fix ที่กำลังจะ deploy เลย — กฎง่ายๆ: ฟีเจอร์ที่ยังไม่จบ ต้องมี
   ทาง "ปิดสนิท" ที่ default ไว้เป็น off ชัดเจน ไม่ใช่ต้องตั้งค่าหลายไฟล์ให้ตรงกันเป๊ะถึงจะปลอดภัย

3. **id/sequence generator ทุกตัวที่ผูกกับ wire protocol ต้อง unit test เรื่อง wrap-around ตั้งแต่
   วันแรก** (หัวข้อ 14.3) — เขียน test ที่บังคับให้ counter วิ่งเกินขนาด field จริงแล้วยืนยันว่า
   ไม่มี id ซ้ำ/ไม่มี entry ค้าง แทนที่จะรอเจอใน production หลังรันมาเป็นชั่วโมง

4. **Dashboard metric ที่จะโชว์ "แข่งกับคู่แข่ง" ต้องออกแบบหน่วยวัดให้เทียบกันได้ตรงๆ ตั้งแต่
   schema** (หัวข้อ 14.2) — เก็บ `createdTime` ของทุกข้อความ (เข้าและออก) ไว้เทียบกับ trigger
   เดียวกันเสมอ อย่าผสมเลข "เวลาที่โค้ดเราใช้ทำงาน" กับ "ช่วงห่างระหว่างข้อความในห้อง" บน UI
   เดียวกันโดยไม่มี label ชัดเจนว่าเป็นคนละหน่วยวัด

5. **Dependency ให้น้อยที่สุดเท่าที่จำเป็นจริง** — frontend เดิมมี dependency จริงแค่ 3 ตัว
   (`react`, `react-dom`, `qrcode`) และ sender (Go) ไม่มี external dependency เลย นี่คือมาตรฐาน
   ที่ควรรักษาไว้ — ก่อนเพิ่ม library ใหม่ ถามก่อนว่า "เขียนเองกี่บรรทัดถ้าไม่ใช้ library นี้" ถ้า
   คำตอบคือ < 50 บรรทัดและไม่ใช่เรื่อง crypto/protocol ที่เสี่ยงเขียนผิด มักคุ้มกว่าที่จะเขียนเอง

6. **แยก "config ที่ปลอดภัยจะแก้บ่อย" ออกจาก "release ที่ต้อง immutable"** ตั้งแต่ต้น (เหมือนที่
   ทำอยู่แล้วกับ `/etc/linebot/*.env` นอก release directory) — อย่าให้ secret หรือ config ที่
   เปลี่ยนบ่อยอยู่ในโฟลเดอร์เดียวกับโค้ดที่ deploy ทับกันทุกรอบ

7. **Compliance ต้องเป็นข้อกำหนดตั้งแต่ design ไม่ใช่ patch ทีหลัง** (จาก
   "แผนวิเคราะห์และปรับปรุงระบบ LINE Bot.md"): ไม่ bypass rate limit, ไม่ manipulate message
   ordering ฝั่งแพลตฟอร์ม, ไม่ multi-account เพื่อ abuse — เทคนิคทุกข้อในเอกสารนี้ต้อง "ตรวจจับ
   เร็วขึ้น/ตอบเร็วขึ้นภายในกติกา" เท่านั้น ไม่ใช่หาทางเลี่ยงกติกา

8. **วัดผลเป็นวินัย ไม่ใช่ตัวเลือก** — ถ้าจะสร้างใหม่ ให้มี `latency_samples`-แบบเดียวกันนี้ตั้งแต่
   deploy แรก พร้อม breakdown ราย phase (หัวข้อ 9) เพราะทุกการตัดสินใจ tuning ในเอกสารนี้มาจาก
   ข้อมูลจริง ไม่ใช่สัญชาตญาณ — ถ้าไม่มีเครื่องมือวัดตั้งแต่ต้น จะย้อนกลับไปเดาแบบเดิมที่เคยพลาด
   มาแล้ว 2 ครั้ง (หัวข้อ 9.2)

---

## 16. เอกสารที่เกี่ยวข้องในโปรเจกต์นี้

| ไฟล์ | เนื้อหา |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | เวอร์ชันย่อของสถาปัตยกรรม+เทคนิค (ภาษาไทย) |
| [SPEED-TECHNIQUES.md](SPEED-TECHNIQUES.md) | เทคนิคความเร็วแบบ generic ใช้เป็น template กับโปรเจกต์อื่นได้ |
| [DEPLOY-README.md](DEPLOY-README.md) | วิธีใช้ deploy script ทั้งสองเซิร์ฟเวอร์แบบละเอียด, troubleshooting |
| [README.md](README.md) | วิธีรัน dev environment, login |
| `deploy/server2/README.md` | รายละเอียด sudoers/shard setup บน Server 2 |
| `แผนวิเคราะห์และปรับปรุงระบบ LINE Bot.md` | แผนปรับปรุงเชิง compliance (ห้ามทำอะไรบ้าง) |

เอกสารนี้ (`PROJECT-BLUEPRINT.md`) คือจุดเริ่มต้นเดียวที่ควรอ่านก่อน — ไฟล์อื่นมีรายละเอียดลึกกว่า
ในบางหัวข้อเฉพาะที่ลิงก์ไว้ด้านบน
