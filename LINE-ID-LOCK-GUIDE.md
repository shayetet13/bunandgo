# LINE Bot: ล็อก 1 บัญชี LINE ต่อ 1 บอท

> เอกสารอธิบายฟีเจอร์ "1 LINE ID ต่อ 1 bot" — กลไก การตั้งค่า และวิธีทดสอบที่ถูกต้อง
> สำหรับใช้กับโปรเจกต์นี้ (โค้ดชุดเดียวกัน) บน **server อื่นที่แยกอิสระ** — ฟีเจอร์นี้อยู่ในโค้ด ไม่ต้องพอร์ตอะไรเพิ่ม แค่ deploy โค้ดชุดนี้ก็ได้ฟีเจอร์นี้ไปด้วยอัตโนมัติ
>
> อัปเดตล่าสุด 18 สิงหาคม 2026 — เพิ่มการล็อก **ชื่อบัญชี LINE (display name)** คู่กับ mid ต่อ 1 บอท (ดูหัวข้อ 2 และ 3) เพื่อปิดช่องที่ mid ตรงกันแต่มีการแชร์/โอนบัญชีให้คนอื่นใช้งานต่อโดยไม่จ่ายเงิน

---

## 1. สรุปสั้นที่สุด

แต่ละ **บอท (1 แถวในตาราง `bots`)** ล็อกกับ **บัญชี LINE บัญชีแรก (mid) และ ชื่อบัญชี ณ ตอนนั้น** ที่ login สำเร็จเข้าไปเท่านั้น ถ้าบัญชี LINE อื่นพยายามสแกน QR เข้าบอทตัวเดียวกัน **หรือบัญชีเดิม (mid ตรงกัน) แต่เปลี่ยนชื่อบัญชีไปจากตอนล็อกครั้งแรก** ระบบจะ**ปฏิเสธก่อนที่บอทจะ online และก่อนที่ token ของบัญชีนั้นจะถูกบันทึก** พร้อมเด้ง modal เตือนภาษาไทยกลางจอ ระบุนโยบาย "1 บัญชี LINE ต่อ 1 บอท" และให้ติดต่อผู้ดูแลระบบหากต้องการเพิ่มบัญชี/อุปกรณ์

ข้อยกเว้น: บัญชี **admin** และ user ที่ถูกตั้งค่าเป็น **"บัญชีทดสอบ"** ไม่ถูกล็อก (ทั้ง mid และชื่อ)

จุดสำคัญที่ต้องรู้ก่อนใช้งาน/ทดสอบ: **การล็อกทำงานที่ระดับ "บอท" ไม่ใช่ "user" หรือ "server"** — บอทสองตัวของ owner คนเดียวกัน (บอทพี่น้อง) ล็อกกับคนละบัญชีกันได้ตามปกติอยู่แล้ว เพราะแต่ละบอทคือ 1 บัญชี LINE แยกกันโดย design ของทั้งระบบ

---

## 2. กลไกการทำงาน

### จุดที่เช็ค
เช็คใน [`backend/src/bot/session-manager.ts`](backend/src/bot/session-manager.ts) ฟังก์ชัน `attemptLogin` — ทันทีหลัง LINE login สำเร็จ (`rt.client = client`) แต่**ก่อน**บันทึก token และก่อน prewarm/ประกาศ online ใดๆ ทั้งสิ้น:

```text
LINE login สำเร็จ
  → ได้ client.base.profile.mid (LINE user id ตัวจริง) + .displayName (ชื่อบัญชี ณ ตอนนี้)
  → เทียบกับ bots.locked_line_mid / locked_line_display_name ที่บันทึกไว้ (ผ่าน evaluateIdLock)
      ├─ exempt        → ปล่อยผ่าน ไม่บันทึกอะไร (admin / user ที่ exempt_id_lock=1)
      ├─ first_login    → บันทึก mid + ชื่อ คู่กันเป็นค่าล็อก แล้วไปต่อตามปกติ
      ├─ match          → mid ตรง และชื่อตรง (หรือยังไม่เคยบันทึกชื่อ) → ไปต่อตามปกติ
      ├─ mismatch       → mid ไม่ตรง → ปฏิเสธทันที (ดูขั้นตอนด้านล่าง)
      └─ name_mismatch  → mid ตรง แต่ชื่อไม่ตรงกับที่ล็อกไว้ → ปฏิเสธทันทีเช่นกัน
  → trackAuthToken() บันทึก token (เฉพาะกรณีไม่ mismatch/name_mismatch)
  → prewarm + wireListeners + ประกาศ online
```

`name_mismatch` คือกรณีที่ตรงกับที่ user รายงาน: บัญชี LINE เดิม (mid ตรงกัน — ผ่านการเช็คบัญชีแล้ว) แต่ชื่อบัญชีที่แสดงตอน login เปลี่ยนไปจากตอนล็อกครั้งแรก ซึ่งเป็นสัญญาณว่าอาจมีการโอน/แชร์บัญชีให้อีกคนใช้งานต่อ (บัญชี LINE ยกให้คนอื่นควบคุมได้โดย mid ไม่เปลี่ยน)

### ตรรกะการตัดสินใจ (pure function, เทสได้โดยไม่ต้องมี LINE client จริง)
อยู่ใน [`backend/src/bot/bots.ts`](backend/src/bot/bots.ts):

```ts
export type IdLockOutcome = "exempt" | "first_login" | "match" | "mismatch" | "name_mismatch";

export function evaluateIdLock(bot: Bot, lineMid: string, displayName: string): IdLockOutcome {
  if (isIdLockExempt(bot)) return "exempt";
  if (!bot.lockedLineMid) return "first_login";
  if (bot.lockedLineMid !== lineMid) return "mismatch";
  if (bot.lockedLineDisplayName && displayName && bot.lockedLineDisplayName !== displayName) {
    return "name_mismatch";
  }
  return "match";
}
```

การเช็คชื่อจะ **ไม่** ทำงานถ้าฝั่งใดฝั่งหนึ่งว่าง — บอทที่ล็อกไว้ก่อนมีฟีเจอร์นี้ (`lockedLineDisplayName` เป็น `null`) จะไม่ถูกลงโทษด้วยชื่อที่ไม่เคยบันทึกไว้ ดูหัวข้อ "การอัปเกรดบอทเก่า" ด้านล่างว่าบอทกลุ่มนี้ถูกจัดการยังไง

แยกออกจาก I/O (DB write, emit event, log) โดยเจตนา — `session-manager.ts` เป็นแค่ตัวเรียกและจัดการผลลัพธ์ ไม่ใช่ตัวตัดสินใจ

### เมื่อเจอ mismatch หรือ name_mismatch ระบบทำ 5 อย่างพร้อมกัน
1. ตัด `rt.client = undefined` — ไม่ให้ session ใช้งานต่อ, ไม่เรียก `trackAuthToken` เด็ดขาด (บัญชีผิดจะไม่ถูกบันทึกไว้เลย)
2. อัปเดตสถานะบอทกลับเป็น `offline`
3. บันทึก anomaly kind `id_lock_mismatch` (mid ไม่ตรง) หรือ `id_lock_name_mismatch` (ชื่อไม่ตรง) severity `critical` (ดูได้ที่หน้า Logs → การรบกวน)
4. บันทึก bot event `id_lock_rejected` หรือ `id_lock_name_rejected`
5. ยิง WS event `id_lock_mismatch` (พร้อม field `reason: "account" | "name"`) → frontend เด้ง modal แดงเต็มจอ (`IdLockAlertModal.tsx`) — ข้อความจะต่างกันตาม `reason`, กรณี `"name"` จะระบุนโยบาย "1 บัญชี LINE ต่อ 1 บอท" และให้ติดต่อผู้ดูแลระบบตามที่ธุรกิจต้องการ

### การอัปเกรดบอทเก่า (deploy sweep)

บอทที่ล็อก mid ไว้ **ก่อน** ฟีเจอร์นี้มีผล (`locked_line_display_name` เป็น `NULL`) จะไม่มีชื่อให้เทียบ — ระบบเลือก **บังคับสแกน QR ใหม่ทันทีตอน deploy** แทนที่จะรอเงียบๆ จนกว่าจะ resume ตามธรรมชาติ (เป็นการตัดสินใจเชิงนโยบายที่ยืนยันกับทีมแล้วว่ายอมรับผลกระทบนี้):

- `backend/src/api/server.ts` เช็คว่า migration `028_bots_locked_line_display_name` เพิ่งถูก apply ในการ boot ครั้งนี้หรือไม่ (ผ่านค่าที่ `runMigrations()` คืนกลับมา) ถ้าใช่ จะเรียก `sweepLegacyIdLockNames()` (`backend/src/bot/session-manager.ts`) **ก่อน** `resumePreviouslyRunningBots()` เสมอ
- สำหรับทุกบอทที่ `locked_line_mid IS NOT NULL AND locked_line_display_name IS NULL` (`listBotsNeedingNameReverification()` ใน `bots.ts`): หยุดบอทถ้ากำลังรันอยู่ แล้วเคลียร์ token ที่เก็บไว้ (เหมือน `/force-relogin`) — **ไม่แตะ `locked_line_mid`** ดังนั้นบัญชีที่สแกนรอบใหม่ต้องเป็นบัญชีเดิมเท่านั้น
- ผลคือบอทกลุ่มนี้ **หลุด offline ทันทีตอน deploy รอบนี้** และต้องมีคนสแกน QR ใหม่ (ด้วยบัญชีเดิม) ก่อนจะกลับมาใช้งานได้ — รันครั้งเดียวจริงๆ เพราะ `runMigrations()` คืนรายการ id เฉพาะ migration ที่เพิ่ง apply ในรอบ boot นั้น การ restart ครั้งถัดไปจะไม่ trigger ซ้ำ
- **ควร deploy ช่วงที่แจ้งเจ้าของบอทล่วงหน้าได้** ไม่ใช่ deploy เงียบๆ ระหว่างเวลาทำงานปกติ เพราะกระทบบอทที่ออนไลน์อยู่ทุกตัวที่ล็อกไว้ก่อนวันนี้

---

## 3. Schema (มากับ migration อัตโนมัติ ไม่ต้องทำมือ)

| ตาราง | คอลัมน์ใหม่ | ความหมาย |
| --- | --- | --- |
| `bots` | `locked_line_mid TEXT` | mid ของบัญชีที่ล็อกไว้ `NULL` = ยังไม่เคย login หลังฟีเจอร์นี้มีผล |
| `bots` | `locked_line_display_name TEXT` | ชื่อบัญชีที่ล็อกไว้คู่กับ mid ณ ตอน login ครั้งแรก `NULL` = บอทเก่าที่ล็อกก่อนคอลัมน์นี้มีอยู่ (ดูหัวข้อ 2 "การอัปเกรดบอทเก่า") |
| `users` | `exempt_id_lock INTEGER NOT NULL DEFAULT 0` | `1` = ยกเว้นล็อกทุกบอทของ user คนนี้ (ทั้ง mid และชื่อ) |

Migration `026_bots_locked_line_mid`, `027_users_exempt_id_lock` และ `028_bots_locked_line_display_name` ใน [`backend/src/db/migrations.ts`](backend/src/db/migrations.ts) รันอัตโนมัติตอน backend boot — **บน server ใหม่ที่ฐานข้อมูลเป็นของตัวเอง (คนละ SQLite file) migration จะรันสร้างคอลัมน์เหล่านี้เองตั้งแต่ครั้งแรกที่ backend เริ่มทำงาน ไม่ต้องแก้อะไรเพิ่ม** — ส่วน migration 028 ยังมีผลข้างเคียงพิเศษด้วย (ดูหัวข้อ 2 "การอัปเกรดบอทเก่า"): ตอนที่มันเพิ่งถูก apply ครั้งแรก จะทริกเกอร์บังคับสแกน QR ใหม่ให้ทุกบอทที่ล็อก mid ไว้แล้วแต่ยังไม่มีชื่อบันทึก

⚠️ **สิ่งที่ไม่ติดตามไปด้วย:** ค่า `exempt_id_lock` ผูกกับ database — server ใหม่มีฐานข้อมูลของตัวเอง ต้องตั้งค่า "บัญชีทดสอบ" ใหม่จากหน้า Users เองอีกรอบ ไม่ sync กับ server เดิม

---

## 4. การตั้งค่ายกเว้น (Exempt)

| กรณี | ยกเว้นเสมอไหม | ตั้งค่าที่ไหน |
| --- | --- | --- |
| บัญชี role `admin` | ✅ เสมอ ไม่ต้องตั้ง | — |
| user role `user` ทั่วไป | ❌ ล็อกตามปกติ | — |
| user ที่ต้องการยกเว้น (บัญชีทดสอบ) | ✅ เมื่อเปิดสวิตช์ | หน้า **Users** → การ์ด user → สวิตช์ **"บัญชีทดสอบ (ยกเว้นล็อกบัญชี LINE)"** — admin เท่านั้นที่ตั้งได้ |

ฟังก์ชันตรวจสอบ: `isIdLockExempt(bot)` ใน `bots.ts` — เช็ค `owner.role === "admin" || owner.exemptIdLock`

---

## 5. กู้คืนบอทที่บัญชีโดนแบน / ต้องเปลี่ยนบัญชี

**⚠️ จุดที่พลาดง่ายที่สุด — ต้องอ่านก่อนใช้งานจริง:**

การ "รีเซ็ตล็อก" ต้องทำ **2 อย่างพร้อมกัน** ไม่ใช่แค่ล้างค่าล็อกในฐานข้อมูล:

1. ล้าง `bots.locked_line_mid`
2. **ล้าง session/token ที่บอทเก็บไว้ด้วย**

ถ้าล้างแค่ข้อ 1 อย่างเดียว — กด "เริ่ม" ใหม่ ระบบจะ **resume ด้วย token เดิมที่ยังไม่หมดอายุแบบเงียบๆ ไม่มี QR ใหม่ขึ้นเลย** แล้วพอ resume สำเร็จ (บัญชีเดิม) กับตอนที่เพิ่งล้างค่าล็อกไป ระบบจะมองว่าเป็น "login ครั้งแรก" แล้วล็อกกลับไปที่บัญชีเดิมทันที — ดูเหมือนรีเซ็ตไม่ได้ผลทั้งที่จริงไม่เคยมีบัญชีอื่นเข้ามาทดสอบเลย (**บั๊กจริงที่เจอและแก้แล้วในระบบนี้** — ดูหัวข้อ 6)

### วิธีที่ถูกต้อง (มีปุ่มให้แล้วในระบบ)
หน้า **บอททั้งหมด** → การ์ดบอทที่มีค่าล็อกอยู่ (ตอนนี้จะเห็นข้อความ "ล็อกกับ: ‹ชื่อบัญชี›" ให้ admin เช็คก่อนตัดสินใจ) → ปุ่ม **"รีเซ็ตล็อกบัญชี"** (admin เท่านั้น, มี confirm 2 ขั้น) — ปุ่มนี้ทำครบทั้ง 2 อย่างให้อัตโนมัติ **และตอนนี้ล้างค่าล็อกทั้งคู่ (mid + ชื่อ) พร้อมกัน**:

```text
กด "รีเซ็ตล็อกบัญชี"
  → หยุดบอท (ถ้ากำลัง online อยู่)
  → clearStoredAuthToken()  ล้าง token ที่เก็บไว้
  → resetBotLockedLineMid()  ล้างค่าล็อกทั้ง mid และชื่อบัญชี
  → กด "เริ่ม" ใหม่ → บังคับต้องสแกน QR จริง → บัญชี+ชื่อใหม่ล็อกเข้าแทนอัตโนมัติ
```

ปุ่มเดียวนี้ครอบคลุมทั้ง 2 สถานการณ์: "บัญชีโดนแบน/ต้องเปลี่ยนบัญชีใหม่" (mid เปลี่ยน) และ "บัญชีเดิมแต่เปลี่ยนชื่อโดยสุจริต" (mid เดิม แต่ชื่อเปลี่ยน แล้วโดน `name_mismatch` ปฏิเสธ) — ไม่มีปุ่มแยกสำหรับรีเซ็ตแค่ชื่ออย่างเดียว เพราะรีเซ็ตทั้งคู่แล้วให้ล็อกใหม่ตั้งแต่ต้นง่ายกว่าและปลอดภัยกว่า

Route: `POST /api/bots/:botId/reset-id-lock` (ดู [`backend/src/api/routes/bot-detail.ts`](backend/src/api/routes/bot-detail.ts)) — เจ้าของบอทเองกดไม่ได้ ต้อง admin เท่านั้น (กันกรณีบัญชีที่ควรถูกล็อกไว้ กดปลดล็อกตัวเอง)

หมายเหตุ: `POST /api/bots/:botId/force-relogin` (ปุ่ม "บังคับสแกนใหม่") **ไม่**ล้างค่าล็อก จึงยังคงบังคับทั้ง mid และชื่อบัญชีเดิมอยู่ — ถ้าชื่อเปลี่ยนไปจริงจะโดน `name_mismatch` เหมือนเดิม ต้องใช้ "รีเซ็ตล็อกบัญชี" เท่านั้นถ้าต้องการให้ชื่อใหม่ผ่าน

---

## 6. บทเรียนจากการทดสอบจริง (สำคัญมากสำหรับคนตั้ง server ใหม่)

**อย่าทดสอบด้วยการกด "หยุด" แล้ว "เริ่ม" ซ้ำบนบอทเดิมโดยไม่รีเซ็ตก่อน** — ตราบใดที่บอทยังมี token ที่ใช้ได้อยู่ ระบบจะ **resume ด้วยบัญชีเดิมเสมอ ไม่มี QR ใหม่ให้สแกน** ไม่ว่าจะตั้งใจสแกนบัญชีอื่นแค่ไหนก็ตาม — นี่ไม่ใช่บั๊กของระบบล็อก แต่เป็นพฤติกรรมปกติของ `resumeWithStoredToken` (คงเส้นทางเดิมไว้เพื่อไม่ให้ต้องสแกน QR ทุกครั้งที่ restart)

### วิธีทดสอบที่ถูกต้อง
1. สร้างบอทใหม่ (หรือใช้บอทที่ยังไม่เคยล็อก — เช็คได้จากไม่มีปุ่ม "รีเซ็ตล็อกบัญชี" โผล่ = ยังไม่มีค่าล็อก)
2. เริ่ม + สแกน QR ด้วยบัญชี A → ควรเข้าได้ปกติ (first_login, ล็อกกับ A)
3. กด **"รีเซ็ตล็อกบัญชี"** (ไม่ใช่แค่หยุด/เริ่มเฉยๆ)
4. กด "เริ่ม" → ต้องได้ QR ใหม่จริงๆ → สแกนด้วยบัญชี A อีกครั้ง (ล็อกกับ A ใหม่ ยืนยันว่า flow ปกติทำงาน)
5. รีเซ็ตอีกครั้ง → กด "เริ่ม" → สแกนด้วยบัญชี **B** (บัญชีอื่นจริงๆ) → ต้องเข้าได้ (first_login รอบใหม่ ล็อกกับ B)
6. รีเซ็ตอีกครั้ง → กด "เริ่ม" → สแกนด้วยบัญชี **A** (บัญชีเก่าที่เคยล็อกไปแล้วรอบแรก) → **ควรโดนปฏิเสธ** เพราะตอนนี้ล็อกอยู่กับ B — เห็น modal แดง + มี anomaly `id_lock_mismatch` ในหน้า Logs

ถ้าขั้นตอนที่ 6 ผ่าน (โดนปฏิเสธจริง) แปลว่าระบบทำงานถูกต้องครบวงจร

### ทดสอบส่วนล็อกชื่อบัญชี (ต่อจากขั้นตอนข้างบน)

7. รีเซ็ตอีกครั้ง → กด "เริ่ม" → สแกนด้วยบัญชี A (ตอนนี้ตั้งชื่อโปรไฟล์เป็น "Alice") → เข้าได้ (first_login ล็อกกับ A + "Alice")
8. กด "บังคับสแกนใหม่" (ไม่ใช่รีเซ็ตล็อก) → เปลี่ยนชื่อโปรไฟล์ LINE ของบัญชี A เป็น "Bob" แล้วสแกน QR ด้วยบัญชี A เดิม → **ควรโดนปฏิเสธ** เป็น `name_mismatch` แม้ mid จะตรงกัน — เห็น modal แดง (ข้อความนโยบาย "1 บัญชี LINE ต่อ 1 บอท") + มี anomaly `id_lock_name_mismatch` ในหน้า Logs
9. กด "รีเซ็ตล็อกบัญชี" → กด "เริ่ม" → สแกนด้วยบัญชี A/"Bob" อีกครั้ง → เข้าได้ (first_login รอบใหม่ ล็อกกับ A + "Bob")

ถ้าขั้นตอนที่ 8 ผ่าน (โดนปฏิเสธด้วย `name_mismatch` ไม่ใช่ `mismatch` ธรรมดา) แปลว่าส่วนล็อกชื่อทำงานถูกต้อง

---

## 7. ตรวจสอบบน production (คำสั่งอ้างอิง)

เช็คว่ามีบอทไหนล็อกอยู่บ้าง และมี mismatch เกิดขึ้นจริงไหม (รันบน Server ที่มี backend, ต้องมี `bun` และเข้าถึงไฟล์ DB ได้):

```bash
cd /opt/linebot/current/backend && bun --no-env-file -e '
import { Database } from "bun:sqlite";
const db = new Database("/opt/linebot/shared/worker.db", { readonly: true });
console.log("บอทที่มีค่าล็อก:");
console.log(JSON.stringify(db.query("SELECT id, name, owner_user_id, status, locked_line_mid, locked_line_display_name FROM bots WHERE locked_line_mid IS NOT NULL").all(), null, 2));
console.log("บอทที่ยังรอสแกนใหม่เพื่อบันทึกชื่อ (ล็อก mid ไว้แล้วแต่ยังไม่มีชื่อ):");
console.log(JSON.stringify(db.query("SELECT id, name, owner_user_id, status FROM bots WHERE locked_line_mid IS NOT NULL AND locked_line_display_name IS NULL").all(), null, 2));
console.log("mismatch ล่าสุด (ทั้งบัญชีและชื่อ):");
console.log(JSON.stringify(db.query("SELECT * FROM anomalies WHERE kind IN (\"id_lock_mismatch\", \"id_lock_name_mismatch\") ORDER BY id DESC LIMIT 10").all(), null, 2));
'
```

(ปรับ path `/opt/linebot/shared/worker.db` ตามจริงถ้า server ใหม่ตั้ง `DB_PATH` ไว้คนละที่)

---

## 8. รายการไฟล์ที่เกี่ยวข้องทั้งหมด

| ไฟล์ | หน้าที่ |
| --- | --- |
| `backend/src/bot/bots.ts` | `evaluateIdLock`, `isIdLockExempt`, `setBotLockedLineMid` (mid+ชื่อคู่กัน), `setBotLockedLineDisplayName` (backfill สำรอง), `resetBotLockedLineMid` (ล้างทั้งคู่), `listBotsNeedingNameReverification` — ตรรกะล้วนๆ |
| `backend/src/bot/session-manager.ts` | จุดเช็คจริงใน `attemptLogin` + `clearStoredAuthToken` + `sweepLegacyIdLockNames` (deploy sweep บอทเก่า) |
| `backend/src/bot/anomalies.ts` | เพิ่ม kind `id_lock_mismatch`, `id_lock_name_mismatch` |
| `backend/src/auth/users.ts` | field `exemptIdLock`, ฟังก์ชัน `setUserExemptIdLock` |
| `backend/src/api/routes/users.ts` | `PATCH /api/users/:id` รับ `exemptIdLock` |
| `backend/src/api/routes/bot-detail.ts` | `POST /api/bots/:botId/reset-id-lock` (admin only, ล้าง mid+ชื่อ), `POST /api/bots/:botId/force-relogin` (คงล็อกทั้งคู่ไว้) |
| `backend/src/api/server.ts` | เรียก `sweepLegacyIdLockNames()` ก่อน `resumePreviouslyRunningBots()` เมื่อ migration 028 เพิ่ง apply |
| `backend/src/api/worker-events.ts` | forward event `id_lock_mismatch` (มี field `reason`) จาก shard กลับ control plane |
| `backend/src/db/schema.ts` / `migrations.ts` | คอลัมน์ + migration 026/027/028, `runMigrations` คืนรายการ id ที่เพิ่ง apply |
| `backend/src/bot/bots.test.ts` | เทส `evaluateIdLock`/`isIdLockExempt`/reset/backfill/`listBotsNeedingNameReverification` ครบทุก outcome |
| `frontend/src/components/IdLockAlertModal.tsx` | Modal แดงเต็มจอ — ข้อความแยกตาม `event.reason` |
| `frontend/src/components/BotsPanel.tsx` | ปุ่ม "รีเซ็ตล็อกบัญชี" + แสดงชื่อบัญชีที่ล็อกไว้บนการ์ดบอท |
| `frontend/src/pages/UsersPage.tsx` | สวิตช์ "บัญชีทดสอบ" |
| `frontend/src/Dashboard.tsx` / `components/UserConsole.tsx` | รับ WS event + render modal (ทั้งฝั่ง admin และ user) |

---

## 9. สรุปกฎ 4 ข้อ (ถ้าจำได้แค่นี้ก็พอ)

1. **1 บอท ล็อกได้ 1 บัญชี + 1 ชื่อบัญชี** — ล็อกครั้งแรกอัตโนมัติ ไม่ต้องตั้งอะไร
2. **บัญชีเดิม (mid ตรง) แต่เปลี่ยนชื่อ ก็โดนปฏิเสธเหมือนบัญชีอื่น** — เพราะเป็นสัญญาณว่าอาจมีการโอน/แชร์บัญชีให้คนอื่นใช้งานต่อ
3. **จะเปลี่ยนบัญชีหรือยอมรับชื่อใหม่ต้องกด "รีเซ็ตล็อกบัญชี" เท่านั้น** — หยุด/เริ่มเฉยๆ หรือ "บังคับสแกนใหม่" ไม่ช่วย เพราะยังคงบังคับทั้ง mid และชื่อเดิมอยู่
4. **exempt ผูกกับ user ใน database นั้นๆ** — ย้าย server ต้องตั้ง "บัญชีทดสอบ" ใหม่เอง
