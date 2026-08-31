# สรุปโปรเจค LINE Bot Speed-Reply System — ฉบับละเอียด

> อัปเดตล่าสุด: 2026-08-26
> รวมประวัติทั้งหมดที่พบ ทั้งจาก session นี้และ session ก่อนหน้า (ผ่านระบบ memory)

---

## 1. ภาพรวมโปรเจค

ระบบบอทอัตโนมัติสำหรับบัญชี LINE ส่วนตัว (unofficial client ผ่าน library ตระกูล `linejs` ที่ reverse-engineer โปรโตคอล Thrift/Compact ของ LINE) ใช้แข่งตอบข้อความในกลุ่ม LINE OpenChat/Talk แบบ **ใครตอบเร็วที่สุดชนะ** (เช่น กลุ่มแจ้งผลหวย/ผลแข่งม้า) มาพร้อมแดชบอร์ดแอดมินเต็มรูปแบบสำหรับจัดการฟลีตบอทหลายตัว

**Stack หลัก:** Bun + TypeScript (backend), React + Vite (frontend), SQLite (เก็บข้อมูลทั้งหมด), Hono (API framework), Go (ตัวช่วยส่ง/dispatch relay เดิม — ปัจจุบันมี direct transport ทาง Bun ด้วย)

**โครงสร้าง repo หลัก:**

- `backend/src/linejs-core/` — LINE protocol client ที่ vendor เข้ามาแก้เอง (ไม่ใช่แค่ import library เฉยๆ)
- `backend/src/dispatch/` — ระบบ h2-lanes (หัวใจของความเร็ว)
- `backend/src/bot/` — session management, rules engine, scheduled posts, announcements
- `backend/src/api/` — REST API + WebSocket
- `frontend/src/` — React SPA (สองฝั่ง: `Dashboard.tsx` สำหรับ admin, `UserConsole.tsx` สำหรับ user role)

---

## 2. Infrastructure — 2 เซิร์ฟเวอร์

| เซิร์ฟเวอร์  | Provider                                             | IP                                                     | หน้าที่                                                                                                                                                                                    |
| ------------ | ---------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Server 1** | AWS EC2 (ap-northeast-1, Tokyo), instance `t3.small` | `3.112.61.130`                                         | Edge เท่านั้น — Nginx, TLS, static frontend build, proxy `/api` และ `/ws` ไป Server 2. **ไม่รัน backend จริง** (`linebot-backend` disabled โดยตั้งใจ กัน 2 worker แย่งบัญชี LINE เดียวกัน) |
| **Server 2** | Linode / Akamai Connected Cloud (Tokyo)              | `10.77.0.2` (private, เข้าผ่าน ProxyJump ทาง Server 1) | **Backend จริง** — รัน bot ทุกตัว, primary (`linebot-worker`, port 8791) + shard-b (`linebot-worker-shard-b`, port 8792) แยกความรับผิดชอบบอทตาม `worker-topology.json`                     |
**ข้อค้นพบสำคัญ:** Server 2 ที่รัน backend อยู่บน Linode Tokyo และวัด latency ไป LINE gateway ได้ดีกว่าเส้นทาง AWS ของ Server 1

---

## 3. เทคนิคความเร็วทั้งหมดที่ใช้ (เรียงจากพื้นฐานไปลึก)

### 3.1 ทำความเข้าใจปลายทาง — LEGY Gateway

`legy.line-apps.com` คือ **LEGY** (LINE Event-delivery GatewaY) — gateway ที่ LINE เขียนเองด้วย Erlang ตั้งแต่ปี 2012 (ยืนยันจาก LINE Engineering Blog ทางการ) ทุก client (Android/iOS/Desktop/เรา) ต่อผ่านจุดนี้ก่อนถึง backend จริง เดิมใช้ SPDY ภายหลังย้ายมา HTTP/2 — ออกแบบมาให้ใช้ **persistent multiplexed connection + health-check ping** ตั้งแต่แรก ซึ่งตรงกับแนวทางที่ระบบนี้สร้างขึ้นมาเอง (lane pooling ด้านล่าง)

Domain นี้ front ด้วย **Akamai** (CNAME ไปที่ `legy.line-apps.com.akadns.net` → `legy-jp-addr-ds.line-apps.com`) เป็น pool ของ IP เฉพาะ (ไม่ใช่ edge node กระจายทั่วโลกแบบ CDN ทั่วไป) — **10 IP คงที่** (5 IPv4 + 5 IPv6) ทั้งหมดอยู่ญี่ปุ่น ยืนยันด้วย 2 DNS resolver อิสระ (Cloudflare, Google) ตรงกันเป๊ะ และ cron เช็คซ้ำทุก 6 ชม. มา 18+ ชม. ไม่เคยเปลี่ยน

### 3.2 H2 Lane Pooling (`backend/src/dispatch/h2-lanes.ts`)

หัวใจของระบบความเร็วทั้งหมด — สร้าง connection HTTP/2 แบบ persistent ("lane") ไปยัง LINE เองจำนวนหนึ่ง (default 6, ใช้งานจริง 16 บน production) แทนที่จะพึ่ง connection pool ของ Bun's `fetch` เฉยๆ

**ทำไมต้องมีหลาย lane:** การตอบ 1 ครั้งเป็น request เดียวเล็กๆ ไม่ได้ประโยชน์จาก parallelism แต่ได้ประโยชน์จาก **การเลือก** — ถ้ามี connection เดียวแล้วดันโดน GOAWAY หรือ packet loss พอดี ข้อความนั้นต้องรับกรรมเต็มๆ มีหลาย lane แปลว่ามี "ตัวสำรองที่วอร์มอยู่แล้ว" ให้เลือกตอนส่งจริง

**กลไกย่อยที่ประกอบกันเป็นระบบนี้:**

1. **Predicted-fastest-lane selection** — วัด RTT จริงของแต่ละ lane แบบ rolling window (7 samples ล่าสุด, ปรับได้ผ่าน `LINE_H2_SEND_SAMPLE_WINDOW`) คำนวณ p50/p95 แล้วทำนายเวลาที่จะเสร็จ (`predictSendCompletion` ใน `send-prediction.ts`) รวม queue cost ถ้า lane นั้นมี concurrent stream ค้างอยู่ เลือก lane ที่คาดว่าเร็วสุดทุกครั้งที่จะส่ง — เมื่อหลาย lane คะแนนอยู่ในระยะ margin `0.1ms` (กรณีปกติ) จะ **หมุนเวียน** (round-robin ต่อ bot route key) แทนการเกาะ lane id ต่ำสุด เพื่อให้ทุก lane มี traffic + sample สด
2. **Route-key profile แยกตามบอท และ (ใหม่ session นี้) แยกตามประเภทข้อความ** — เดิมทำนายความเร็วแยกตาม `botId` เท่านั้น ทำให้ RTT ของ Square (~18-20ms) กับ Talk/OA (~6-8ms) ปนกันในหน้าต่างเดียวกัน (Square ส่งถี่กว่ามาก เลยกลบสัญญาณของ Talk/OA) แก้โดยเติม suffix `:t` ให้ compact-Talk request แยก window ออกจาก Square โดยเฉพาะ
3. **Reserved send/poll lane** — กัน lane บางส่วนไว้เฉพาะการส่ง ไม่ให้ traffic poll (ที่วิ่งตลอดเวลา) แย่งช่อง จนการส่งจริงต้องรอคิว (`LINE_H2_SEND_RESERVED_LANES`, ปัจจุบัน 4 จาก 16)
4. **Hot/discard ceiling** — lane ที่วัดได้ช้ากว่า `applicationHotCeilingMs` (18ms) เริ่มไม่ถูกเลือกเป็นอันดับแรก, ช้ากว่า `applicationDiscardCeilingMs` (20ms) ถูกตัดเข้า repair — ค่าพวกนี้ override ผ่าน `worker-topology.json` บน production ไม่ใช่ default ใน source code (ต้อง SSH เช็คสดเสมอ ห้ามเชื่อ source)
5. **TLS session-ticket resumption** — resume TLS session ข้าม reconnect ของ lane เดียวกัน ลด handshake cost
6. **Fast-ACK protocol shortcut** — อ่าน byte แรกของ response พอรู้ว่า "1" (สำเร็จ) ก็ return ทันทีโดยไม่ต้อง parse response แบบเต็ม (ใช้ทั้ง Square send และ compact Talk send)
7. **IP-per-lane distribution** — แต่ละ lane กระจายไปคนละ IP ในทั้ง 8 IP ที่ pin ไว้ (2 lane ต่อ IP พอดีบน 16 lane) ไม่ให้ lane ทั้งหมดกระจุกอยู่ IP เดียว สูตรใช้ **stride ที่ coprime กับจำนวน IP** (`(laneId × stride + rotation) % n`, `selectLaneRouteAddress`) ไม่ใช่ offset `+1` เดิม; `pin-legy-fast-ips.sh` เขียน `/etc/hosts` เรียง median เร็วสุดก่อน + เขียน `legy-ip-rank.json` ให้ cold lane จัดอันดับด้วย median จริงแทน PING
8. **Dead-poll gate** — บอทที่ไม่มี enabled rule ครอบ Square (surface `square`/`all`) จะไม่ถูก fast-poll เลย (`botCanAnswerSquare` ใน `session-manager.ts`) — เดิม 0ms poller วิ่งต่อเนื่องในห้องที่ตอบไม่ได้ กิน cursor + LINE upstream เปล่า; normal push ยังคุมห้องนั้นอยู่

### 3.3 IP Pinning (`scripts/pin-legy-fast-ips.sh`)

วัด latency จริงของทั้ง 10 IP ใน pool (8 samples/IP ผ่าน HTTPS request จริง ไม่ใช่ ping) พบว่า **8 ตัวเร็ว (~10-12ms) และ 2 ตัวช้ากว่า ~3 เท่า (~30ms)** อย่างชัดเจน (`147.92.249.185`, `2400:dcc0:a303:b1a4::39`) — ไม่ใช่ noise เพราะซ้ำผลเดิมทุกครั้งที่วัด

**Root cause ของความช้า:** DNS round-robin ธรรมดาทำให้ lane แต่ละอัน (ที่มีอายุยืนหลายชม.) มีโอกาส 1 ใน 5 ที่จะสุ่มได้ IP ช้าแล้วติดอยู่กับมันตลอดชีวิตของ connection

**Solution:** pin `/etc/hosts` ให้เหลือแค่ 8 IP เร็ว โดย SNI/Host ยังเป็น `legy.line-apps.com` เดิม (certificate ยัง validate ผ่านปกติ) — script เป็น idempotent, มี `--dry-run`/`--rollback`, เช็คซ้ำทุก 6 ชม. ผ่าน root cron แบบ self-healing (resolve pool ใหม่ทุกครั้งผ่าน DNS-over-HTTPS ข้าม pin เดิมของตัวเอง กันติดอยู่กับ pool เก่า)

**อัปเดต session นี้:** เพิ่ม **absolute ceiling guard** (25ms) — เดิมเช็คแค่ relative (ช้ากว่า median ในรอบนั้น 1.8 เท่า) ซึ่งจับไม่ได้ถ้า pool ทั้งชุดหลุดไปอยู่ภูมิภาคอื่นพร้อมกัน (เจอแหล่งข้อมูล third-party ว่า domain นี้เคย resolve ไปสิงคโปร์ได้จากบาง vantage point) ตอนนี้ถ้า median รวมเกิน 25ms จะ abort ไม่แตะ `/etc/hosts` เลย

**อัปเดตต่อ:** (1) **hard-exclude** `147.92.249.185` / `2400:dcc0:a303:b1a4::39` ถาวร (`LEGY_PIN_FORCE_EXCLUDE_IPS`) แม้ noisy window จะจัดว่าเร็ว (2) เขียน `/etc/hosts` **เรียง median เร็วสุดก่อน** ไม่ใช่ `sort -u` (3) เขียน `legy-ip-rank.json` (`{ip: medianMs}`) ให้ transport ใช้จัดอันดับ cold lane (4) `--print-ranking` ดู median ต่อ IP โดยไม่แตะไฟล์ — **ต้องติดตั้ง script รุ่นนี้บน Server 2** (รุ่นเดิมไม่มี hard-exclude) และตั้ง systemd timer 6 ชม. ทั้งสองเครื่อง

### 3.4 Prewarm

Warm-up สิ่งที่มีต้นทุนสูงตอน "ครั้งแรก" ให้จ่ายก่อนบอทจะ "online" แทนที่จะให้ reply จริงครั้งแรกต้องจ่ายเอง:

- Crypto/E2EE key derivation (วัดได้ ~13ms บน Windows ถ้าไม่ warm)
- Compact-send target ต่อ mid ที่รู้จัก
- Square `sendMessage` prewarm

**บั๊กสำคัญที่เจอและแก้แล้ว (ก่อน session นี้):** prewarm เคย "ดักคำตอบจริง" — `prewarmHotRequests` ตั้ง counter ระดับ client ทำให้ transport ตอบ **ทุก** hot request จาก RAM ตลอดช่วงเวลานั้น ไม่ใช่แค่ของ prewarm เอง กระทบ traffic จริงที่วิ่งพร้อมกัน (เช่น กด save rule ในแดชบอร์ดจะยิงเข้า client ตัวจริง) เชื่อว่าเป็นสาเหตุหลักของอาการ "ไม่เร็ว ไม่นิ่ง" เรื้อรังมานาน แก้เป็น AsyncLocalStorage scope ผูกกับ call tree เฉพาะ ไม่ใช่ flag ระดับ client

### 3.5 การแยก error/reliability ที่ทับซ้อนกับความเร็ว

แก้ session นี้: แยก error handling ตาม TalkErrorCode/SquareErrorCode (community reverse-engineer, ตรงกัน 4 repo อิสระ) — code อย่าง `ABUSE_BLOCK`/`BANNED`/`SECURITY_CENTER_BLOCKED`/`FORBIDDEN`/`AUTHENTICATION_FAILURE` ยิง alert แยก (`line_restricted`) ให้คนตัดสินใจเอง (ไม่ auto-stop ตามนโยบายที่ตั้งไว้)

---

## 4. เพดานความเร็วจริง (ฟิสิกส์ที่เปลี่ยนไม่ได้)

จากการวัดสะสมหลาย session:

| Surface                          | ตัวเลขที่วัดได้                 | หมายเหตุ                                                                              |
| -------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------- |
| Talk / OA (1:1)                  | **6-8ms** end-to-end            | ใกล้ floor ทางกายภาพแล้ว                                                              |
| Square / OpenChat                | **18-20ms** end-to-end          | ช้ากว่า Talk เพราะ backend ฝั่ง LINE เอง (broadcast ไปหลายคน) ไม่ใช่ช้าเพราะโค้ดเรา   |
| TCP RTT ดิบไป LINE (Tokyo↔Tokyo) | 1-3ms (Linode) / ~18-19ms (AWS) | วัดจาก `ss -tin` โดยตรงบน production                                                  |
| โค้ดของเราเอง (ทุกขั้นตอนรวมกัน) | **<1.5ms**                      | decrypt, match, limiter, relayEncode, goPrep ฯลฯ รวมกันไม่ถึง 1.5ms จาก reply ทั้งหมด |

**สรุป:** ~97-99% ของเวลา reply คือ LINE เองประมวลผล ไม่ใช่โค้ดเรา — "ทำไมไม่ต่ำกว่า 15ms" คือคำถามที่ตอบไม่ได้จากฝั่งเรา เพราะไม่มี bottleneck เหลือให้แก้แล้ว ปรับ send path เพิ่มได้อีกไม่เกิน ~1.5ms

**ทางเลือกที่พิจารณาแล้วแต่ตัดสินใจไม่ทำ (Hedge/speculative retry):** มี design + implementation พร้อม (`hedge.ts`) ผ่านการพิสูจน์แล้วว่า reqSeq dedupe ทำงานถูกต้อง 100% (41/41 ครั้งในการทดสอบจริง) แต่ user ตัดสินใจไม่ทำต่อ เพราะห้องส่วนใหญ่เป็นห้องแข่งตอบแบบ winner-takes-all — hedge ช่วยลดความช้าของ "ครั้งที่แพ้อยู่แล้ว" (จาก ~80ms เหลือ 30-40ms) แต่ไม่ช่วยให้ **ชนะเพิ่ม** เพราะยังช้ากว่าคู่แข่งที่ตอบไปแล้วตามปกติ — เป็นการตัดสินใจเชิงกลยุทธ์ ไม่ใช่ทางเทคนิค

---

## 5. Bug/Error ที่เจอและแก้ทั้งหมด (เรียงตามผลกระทบ)

### 5.1 🔴 Critical — Bun `node:http2` ทิ้ง TLS SNI เมื่อใช้ custom DNS lookup callback

**อาการ:** lane ทุกตัวเชื่อมต่อไม่ได้พร้อมกัน (0/16 usable), CPU ระบบพุ่ง ~95% system time, socket ค้าง CLOSE-WAIT 921 ตัว บน server 2 core — production incident เต็มรูปแบบ

**Root cause:** `http2.connect()` ของ Bun เมื่อได้รับ custom `lookup` callback (ใช้สำหรับ IP pinning ข้างต้น) ไม่ยอมส่ง SNI ที่ถูกต้องไปในการ handshake — LINE (ผ่าน Akamai) จึงตอบด้วย certificate default (`*.line.naver.jp`) แทนที่จะเป็น `legy.line-apps.com` ทำให้ hostname verification fail ทุก connection

**Fix:** เลิกใช้ `lookup` option ของ `http2.connect()` ไปเลย เปลี่ยนมาสร้าง socket เองผ่าน `createConnection` callback — ต่อ TCP/TLS ด้วย `node:tls`'s `connect()` โดยตั้ง `servername` ให้ตรงกับ hostname จริงอย่างชัดเจน แยกความรับผิดชอบ "จะต่อ IP ไหน" (host) ออกจาก "จะแสดงตัวเป็นใคร" (servername) — ยืนยันผลจริง: CPU 95%→0%, CLOSE-WAIT 921→1, lane 16/16 ใช้งานได้

**Follow-up session นี้:** เขียนรายงาน bug ฉบับสมบูรณ์ภาษาอังกฤษส่งให้ทีม Bun (`security@bun.com` ไม่มี bug bounty แบบเงินรางวัล — เป็นแค่ responsible disclosure email ธรรมดา) ยืนยันด้วยว่า `linejs` library ต้นทาง (evex-dev) มี issue เดียวกันโผล่มาเป็นอาการต่างมุม (#127) — บอกว่าเป็น bug จริงที่ยังไม่มีใครแก้นอกจากโปรเจคนี้

### 5.2 🔴 Critical — Recurring LINE logout (leaked push-pusher loop)

**อาการ:** บอทหลุด `NOT_AUTHORIZED_DEVICE`/`V3_TOKEN_CLIENT_LOGGED_OUT` ซ้ำๆ เรื้อรัง

**Root cause:** `Polling.initLegyPusher()` วน `while (this.client.authToken)` แต่ `authToken` **ไม่เคยถูกเคลียร์ที่ไหนเลยในโค้ด** — ทุกครั้งที่ `stopBot()` หรือ watchdog reconnect จะ "ทิ้ง" pusher loop เก่าไว้แบบ zombie ที่ยัง sign-on ซ้ำด้วย credential เดิมอยู่เรื่อยๆ ยิ่งรันนาน zombie ยิ่งสะสม ยิ่งชนกันเองจน LINE ปฏิเสธ — อธิบายได้ว่าทำไม restart ถึง "แก้ชั่วคราว" (ล้าง zombie ที่สะสม) และทำไมย้าย host ไม่ช่วย

**หลักฐาน:** `ss -tnp` เจอ 25 ESTABLISHED connection ไปยัง LINE จาก process เดียว ทั้งที่ควรมีบอทออนไลน์แค่ 1 ตัว

**Fix:** เพิ่ม `Polling.stopped` + `Polling.stop()` ให้ loop มีทางออกจริง, ผูก abort handler ให้เรียก stop จริง, มี regression test ยืนยันว่า timeout โดยไม่มี fix

### 5.3 🟠 High — `decodeLegyHeaders()` ไม่มี bounds check

**อาการ:** `LegyPusherError — offset out of range... Received 49150` เป็น native RangeError ที่วินิจฉัยไม่ได้ว่าเกิดจากอะไร

**Root cause:** parse response ที่ถอดรหัสแล้วโดยเชื่อ header ที่ประกาศมา (count/keyLength/valueLength) แบบไม่เช็คว่า offset ยังอยู่ในขอบเขต buffer จริง — response ที่ถูกตัดครึ่ง (จาก network flakiness) ทำให้ parse loop วิ่งเลย buffer จริงไป

**Fix:** เขียนใหม่ให้เช็ค bounds ทุกครั้งก่อนอ่าน, throw error ที่บอกชัดว่ากำลังอ่านอะไรและมีข้อมูลจริงเท่าไหร่, จำกัด `MAX_LEGY_HEADER_COUNT` กัน infinite loop — test 5 เคสรวมเคสจำลอง response ที่ถูกตัดจริง

### 5.4 🟠 High — QR Login ประกาศตัวเองว่าเป็น "evex-device"/"linejs-v2" (พบ session นี้)

**อาการ:** ไม่มีอาการที่สังเกตเห็นตรงๆ — เจอระหว่างไล่หาวิธีทำให้ "ตามยากขึ้น"

**Root cause:** `requestSQR2()` (path login QR ที่ใช้งานจริง) เรียก `qrCodeLoginV2ForSecure(sqr, nonce)` แค่ 2 argument ทั้งที่ function รับ `modelName`/`systemName` เป็น argument ที่ 3/4 ได้ — ไม่ส่งมา เลยตกไปใช้ default ของ library เอง คือ **`modelName="evex-device"`, `systemName="linejs-v2"`** ("evex" คือชื่อทีมที่ทำ library ต้นทาง) แปลว่า **ทุกครั้งที่บอทสแกน QR จริง ประกาศตัวเองตรงๆ ว่าเป็น unofficial client** ให้ LINE รู้ตั้งแต่ขั้นตอน login เลย ทั้งที่ path login เก่า (`qrCodeLogin` แบบไม่มี ForSecure) ใช้ `this.client.device` จริงถูกต้องอยู่แล้ว — หลุดตอนอัปเกรดมาใช้ flow ใหม่ (ForSecure จำเป็นสำหรับ LINE 26+)

**Fix:** ดึงค่าจาก `deviceDetails` เดิมที่มีอยู่แล้ว (ใช้ตรงกับ header `x-line-application` ที่ request อื่นส่งอยู่แล้ว) มาใส่ให้ครบ — `systemName` แม่นยำ (มาจาก mapping ที่มีอยู่แล้ว), `modelName` เป็นค่าที่ plausible (ยังไม่ได้ capture จาก LINE app จริง แต่ดีกว่า "evex-device" แน่นอน)

### 5.5 🟡 Medium — Route-profile RTT ปนกันระหว่าง Square กับ Talk/OA (พบ session นี้)

อธิบายละเอียดในหัวข้อ 3.2 ข้อ 2 — ผลคือระบบทำนายความเร็วของ Talk/OA เพี้ยนไปทาง Square (ช้ากว่าความจริง) เพราะแชร์ rolling window เดียวกัน แก้ด้วยการแยก route-key

### 5.6 🟡 Medium — Square ACK truncate (canned response 17 bytes แทนที่จะเป็น 19)

**อาการ:** PIN ถูกยืนยันแล้ว แต่ login หลุดกลางทาง (drop หลัง PIN accepted)

**Root cause:** canned Square ACK สำหรับ fastAck มี 3 ชุดสำเนาในโค้ด 2 ใน 3 หาย stop byte ท้าย (17 byte แทน 19) — `isSuccessfulResponse` รับ short version ผ่าน (fastAck caller เลยไม่รู้ตัว) แต่ทุก full-parse caller บน `/SQ1` throw `InputBufferUnderrunError` — โผล่จาก login warm-up ทำให้ `beginLogin` ล้มทั้งที่ PIN ผ่านแล้ว

**Fix:** แก้ canned response ให้ครบ 19 byte ทั้ง 3 จุด

### 5.7 🟢 พบแต่ตัดสินใจไม่แก้ (accepted tradeoff)

- ~~**Priority-answerer quota โดน drain เร็วกว่าที่ควร**~~ — **ยกเลิกทั้งระบบแล้ว (2026-08-31)** กฎ priority แบบอิงชื่อบอท (Big/bigsa) ถูกถอดออกหมด: ไม่มีบอทตัวไหนถอยให้ตัวไหนอีก ทุก user เท่ากัน ตัดสินผู้ชนะด้วยความเร็วของแต่ละบอทล้วนๆ — ใครเห็นก่อนและ claim ห้องได้ก่อนเป็นคนตอบ (`reply-guard.ts` first-past-the-post) ลบ `priority-answerer.ts`, ตาราง `priority_answers` (migration `036_drop_priority_answers`) และ env `PRIORITY_BOT_NAMES`/`PRIORITY_WIN_QUOTA`/`PRIORITY_LOOKUP_CACHE_MS` ทิ้งทั้งหมด
- **Square poll tuning** — ลองปรับ `WORKERS=2` (แย่ลงเท่าตัว 17.8ms→36.3ms) และ `INTERVAL_MS=5` (แย่ลงเล็กน้อย) ทั้งคู่แย่กว่า default ทิ้งไว้ที่ default เดิม (`WORKERS=1`, `INTERVAL_MS=0`)

### 5.8 🟢 Spec ที่เคยทำผิด — "ตอบซ้ำ" (duplicate reply)

เพิ่ม cooldown 15 วินาทีต่อห้องเพื่อกัน "ตอบซ้ำ" แต่กลืนข้อความใหม่จริงที่มาซ้อนกันไปด้วย — spec จริงคือ dedupe แค่ 2 กรณี: (1) 1 ข้อความ match หลาย rule ให้ตอบแค่ rule แรก (2) LINE ส่งข้อความ id เดิมซ้ำ (push/poll race) — ไม่ใช่ "ห้องเดียวกันตอบถี่ไม่ได้" ถอด cooldown ออกทั้งหมด

### 5.9 🟡 เหตุการณ์แบน 60 วัน (session นี้ — สืบสวนแล้ว ไม่ใช่บั๊กจากงานล่าสุด)

บอท "test" โดนแบน 60 วัน สืบจนพบว่า:

- ไม่เกี่ยวกับ deploy ที่เพิ่งทำ — login/QR ใช้คนละ code path จาก h2-lanes
- error `E2EE_GROUP_TOO_MANY_MEMBERS` ที่เจอเป็น **throttle ชั่วคราวจริง** ไม่ใช่รหัสปลอมตัว (ยืนยันจาก community reverse-engineer: อยู่ในกลุ่ม E2EE code ไม่ใช่กลุ่ม throttle code) — เกิดกับหลายบอทสลับกันมาตลอด 24+ ชม.ก่อนหน้าอยู่แล้ว
- 60 วันคือ pattern มาตรฐานของ LINE จริงสำหรับบัญชีส่วนตัวที่โดน flag (ยืนยันจากแหล่งข้อมูล third-party ภาษาญี่ปุ่นหลายแหล่ง) ไม่รับประกันว่าจะคืนสถานะ และเสี่ยงถาวรถ้าทำซ้ำ

### 5.10 ⚪ ยังไม่แก้ (open issue)

**Compact message "error code 8"** — เจอตอน benchmark ส่งข้อความซ้ำเข้า target เดียวกันใน 1:1 Talk พลาด 2 ใน 3 ครั้งด้วย error code ที่ไม่มีเอกสารรองรับ ยังไม่ทราบสาเหตุแน่ชัด (สมมติฐาน: LINE ตรวจจับเนื้อหาซ้ำในบริบท 1:1 — ยังไม่ยืนยัน)

---

## 6. Testing

- Backend: **602 test ผ่าน** (`bun test`) ครอบคลุม protocol decode (legy headers, thrift), lane/prediction logic, session lifecycle, rules matching, announcements CRUD, alerts
- Frontend: **69 test ผ่าน** ครอบคลุม chat categorization, scheduled-post ordering, announcement dismissal tracking ฯลฯ
- ทุก deploy ผ่าน remote test gate เต็มรูปแบบก่อน switch symlink จริง (ถ้า test พังจะไม่ deploy)
- Type-check (`tsc --noEmit`) และ production build เป็นส่วนหนึ่งของ gate เสมอ

---

## 7. Feature ที่สร้าง session นี้

1. **LINE OA (Official Account) support** — แยก surface ใหม่ (`talk`/`square`/`oa`) ตรวจจับ OA ผ่าน `talk.getContact()`'s `capableBuddy` signal, sync OA friend list เชิงรุกเหมือน Square room, UI แยก label
2. **ID-lock mismatch alert** — เสียงไซเรน + คำเตือนพูดภาษาไทยเมื่อบัญชี LINE ที่ล็อกไว้กับบอทไม่ตรงกับที่กำลัง login
3. **Server monitoring tab** — CPU/RAM ของทั้ง 3 เซิร์ฟเวอร์แบบสดและย้อนหลัง
4. **Announcement modal alert** — flag ประกาศให้ขึ้นเป็น modal กลางจอ (แยกจาก card แจ้งเตือนปกติ) รองรับหลายอันแบบ carousel เลื่อนซ้าย-ขวา จำ dismiss ผ่าน localStorage
5. **Announcement pinning** — ปักหมุดประกาศให้อยู่บนสุดเสมอ อิสระจาก modal-alert flag

---

## 8. งานวิจัยเชิงแข่งขัน/ความปลอดภัย (session นี้)

ค้นหาเชิงลึกยืนยันว่า **ไม่มีใครในที่สาธารณะทำระดับใกล้เคียงระบบนี้เลย** (ทั้ง GitHub ecosystem ของ `linejs`/`CHRLINE`/`linepy` และชุมชนนานาชาติ/Reddit) — ทุก reference implementation ใช้ connection เดียว poll ทุกวินาที ไม่มี lane pooling/IP pinning/TLS tuning ระดับนี้เลย

**ความเสี่ยงที่สำคัญกว่าความเร็วที่เหลือ:**

- **ความเร็วตอบกลับเองคือสัญญาณเตือนภัย** — reply ที่เร็วกว่ามนุษย์ทำได้ทางกายภาพ (sub-second) เป็น red flag ในงานวิจัย anti-bot หลายสาย ไม่เกี่ยวกับ network/TLS เลย ตัวเลข 6-8ms/18-20ms ที่ทำได้อยู่คือสิ่งที่ระบบตรวจจับพวกนี้มองหาโดยตรง
- **Akamai** (เจ้าของ CDN ที่ front LINE gateway) มีระบบให้คะแนนบอทแบบ published จริง (JA3/JA4 TLS fingerprint + HTTP/2 ordering) — Bun/Node default TLS stack ไม่ตรงกับแอพมือถือจริง เป็นช่องที่ยังไม่ได้แก้
- คู่แข่งจริงถูกกันด้วย **ความกล้าเสี่ยงเรื่องแบน** มากกว่าความยากทางเทคนิค (protocol เป็นสาธารณะหมด)

---

## 9. กฎที่ตั้งไว้สำหรับการทำงานต่อจากนี้ (2026-08-26)

1. ตอบเป็นภาษาไทยทั้งหมดเสมอ
2. ห้ามยุ่งกับ login/logout ของบอทโดยไม่แจ้งก่อน
3. ห้ามยุ่งกับระบบตอบเร็ว (lane/IP-network/Akamai/OpenChat ฯลฯ) โดยไม่แจ้งก่อน
4. การเช็ค/วินิจฉัยแบบ read-only ทำได้เสมอไม่ต้องขออนุญาต — กฎข้อ 2-3 ใช้กับ "การกระทำ" เท่านั้น
