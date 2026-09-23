# PID 33136 — สรุปสถานะ Session

**Project:** `F:\webapp\bot linejs bun` (LINE bot — production, มีประวัติโดนแบนจากการทดลองความเร็วแบบไม่ระวังมาก่อน)
**Plan file:** `C:\Users\Administrator\.claude\plans\greedy-roaming-squid.md`
**สถานะปัจจุบัน:** ✅ **Part A + Part B เสร็จแล้ว** — เหลือ commit (รอ user สั่ง) + ถาม B4

---

## 📋 บริบทงาน

User ขอ: อ่าน 5 ไฟล์เอกสาร (`PROJECT-BLUEPRINT.md`, `ARCHITECTURE.md`, `SPEED-TECHNIQUES.md`, `README.md`, `DEPLOY-README.md`) เทียบกับโค้ดจริง แล้ว **"ทำให้เหมือนเอกสาร"** — เชื่อว่า ~97 commits หลังจากจุดที่เอกสารตรงกับโค้ด (`6a0724b`) ทำให้โค้ด "เละและช้าลง"

**ข้อสรุป (ยืนยันกับ user ผ่าน AskUserQuestion แล้ว): ทำตามหลักฐาน** — เก็บโค้ดที่พิสูจน์แล้ว (worker-sharding + SEND-lane-selection มี incident จริงรองรับแทบทุกจุด) ลบแค่ dead code จริง 2 จุด แล้วแก้เอกสารให้ตรงกับโค้ด (ไม่ใช่ revert โค้ด) — ตรงกับ precedent ของ commit `599bb2c` เอง

---

## ✅ Part A — Code cleanup (เสร็จ, verify ผ่านหมด — จาก session ก่อน)

1. **ลบ `hedge.ts` ทั้งไฟล์** (dead code — mode `"on"` ถูก hard-reject, ไม่มี frontend เรียก)
   - ลบ `backend/src/dispatch/hedge.ts` + `hedge.test.ts`
   - เอา import + route `GET/PUT /api/system/hedge` ออกจาก `system.ts` + `system.test.ts`
   - เอา `LINE_HEDGE_*` ออกจาก `.env.example`, อัปเดต comment ใน `square-poll-quiet.ts`
2. **ตัด `logLaneDistribution()` (marked TEMPORARY) + 2 call site + counter** ใน `h2-lanes.ts`
3. **ค้นพบเพิ่ม + apply:** `SEND_MIN_INTERVAL_MS` ตายในโค้ดจริง (rate-limiter.ts comment ยืนยัน) → ลบออกจาก `.env.example`
4. **Verify:** `bun test` → 601 pass / 0 fail, `tsc --noEmit` clean, `grep -ri hedge` เหลือแค่ false-positive

---

## ✅ Part B — Documentation reconciliation (เสร็จครบทุกจุดใน plan)

| # | งาน | สถานะ |
|---|-----|--------|
| B1.§2 | `PROJECT-BLUEPRINT.md` code-size table — re-measure + เพิ่ม security/announcements | ✅ |
| B1.§3.1 | worker-sharding: เพิ่ม `worker-topology.json`, `balanced-sticky` mode + `owner_worker_assignments`, reframe warning 2026-08-12 เป็น "closed by `validateWorkerTopology()`" | ✅ |
| B1.§4 | file structure: เพิ่มไฟล์ที่หายใน `bot/` (17) + `dispatch/` (6) + `security/` + `announcements/`, แก้ line counts, แก้ split `chat-access.ts` (ที่เก็บ) vs `incoming-message-policy.ts` (ด่านตรวจ) | ✅ |
| B1.§6 | message-flow step 2 — credit `incoming-message-policy.ts` (เรียก `chat-access.ts`) + 1-1 talk exclusion | ✅ |
| B1.§7.4 | SEND-lane-selection: สูตร `send-prediction.ts` (`p50 + jitter×0.35 + queueMs`), ค่าคงที่ `lane-speed-policy.ts` (`SEND_SLOW_FLOOR_MS=23` + ประวัติ 28→23→20→23, ratio 1.5, cooldown 15s, pin 21/23), IP-rank cold lane, age recycle | ✅ |
| B1.§13 | env var table เขียนใหม่ทั้งบล็อก — เพิ่ม `WORKER_ASSIGNMENT_*`/`WORKER_TOPOLOGY_FILE`/`WORKER_ROUTES`/`WORKER_PRIMARY_ID`/`WORKER_ID`, `LINE_H2_SEND_*` policy, `LINE_H2_APPLICATION_*`, `REPLY_DEFENSE_*`/`REPLY_UNIQUIFY*`/`AUTOMATIC_REPLY_ECHO_TTL_MS`/`HOT_WARMUP_*`/`SQUARE_FAST_POLL_QUIET_MS`; ลบ `SEND_MIN_INTERVAL_MS` (dead); default sync กับ `.env.example` (PORT 8790, DB_PATH `data/app.db` ฯลฯ) | ✅ |
| B1 §12/§15 | touch-up: step 7 = `validateWorkerTopology()`, §15 item 1 (79% / ~23K), item 2 (shard-b gap "ปิดแล้ว") | ✅ |
| B2 | `ARCHITECTURE.md` — mirror ใน §2/§3.1/§4 (เพิ่ม `owner_worker_assignments`, `announcements`, `app_meta`)/§5/§6/§7.4 แบบย่อกว่า | ✅ |
| B3 | `SPEED-TECHNIQUES.md` — date → 1 ก.ย., "ค่าที่ต้องยึด" + §8 env template อัปเดต, เพิ่ม subsection **3.6** (predicted-completion SEND + relative cooldown + pin hysteresis) เขียนแบบ generic/portable | ✅ |
| — | `README.md` — แก้ประโยค `SEND_MIN_INTERVAL_MS` (dead) ใน Notes | ✅ (นอก plan, correctness fix เล็ก) |

**Verify Part B:** proofread รายหัวข้อเทียบ source จริง (ไม่เทียบ doc กับ doc) ตาม plan ข้อ 4 — ไม่มี automated check; docs-only ไม่กระทบ production

---

## 🔴 ค้างอยู่ / ต้องทำต่อ

1. **Commit** — ยังไม่ได้ commit (รอ user สั่งตาม harness rule) ตอนนี้ working tree มี:
   ```
   M  PROJECT-BLUEPRINT.md  ARCHITECTURE.md  SPEED-TECHNIQUES.md  README.md
   M  backend/.env.example
   M  backend/src/api/routes/system.ts  system.test.ts
   M  backend/src/bot/square-poll-quiet.ts
   M  backend/src/dispatch/h2-lanes.ts
   D  backend/src/dispatch/hedge.ts  hedge.test.ts
   ```
   แนะนำแยก 2 commit: (A) `refactor: drop dead hedge module + always-on lane log` (B) `docs: reconcile blueprint/architecture/speed-techniques with validated dispatch+sharding code`
2. **B4 — ต้องถาม user**: เจอเอกสารสถาปัตยกรรมเพิ่มอีก 4 ไฟล์ที่อยู่นอก 5 ไฟล์ที่ระบุ และบางส่วน **ยังพูดถึง 3-server topology / `hedge.ts` ที่ลบไปแล้ว**:
   - `NETWORK-LANE-RACE.md` — ลึกเรื่อง lane race (ยังอ้าง "ระบบไม่ hedge" ซึ่งตอนนี้ถูกแล้ว)
   - `LINE-BOT-LATENCY-PLAYBOOK.md`
   - `PROJECT-SUMMARY.md` — บรรทัด 100 ยังเขียน "มี implementation พร้อม (`hedge.ts`)" — stale
   - `LINEJS-REWRITE-SPEC.md`
   → ถาม user ว่าจะ fold/retire/อัปเดตแยกไหม (plan บอกว่านอก scope งานนี้)
3. ไม่ต้อง deploy/canary — Part A = dead-code + log removal, Part B = docs-only

---

## 🎯 สรุป Action ที่ต้องตัดสินใจ

| # | เรื่อง | Action |
|---|--------|--------|
| 1 | Commit Part A + Part B | `git add -A && git commit` (แยก 2 commit ตามด้านบน) — verify ผ่านหมด ไม่กระทบ production |
| 2 | เอกสารซ้อนอีก 4 ไฟล์ (B4) | ถาม user: fold / retire / อัปเดตแยก |
