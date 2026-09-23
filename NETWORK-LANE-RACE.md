# NETWORK · LINE ↔ AKAMAI และ LANE RACE

เอกสารนี้สรุปการทำงานของระบบ network lane ที่ใช้งานจริงบน Server 2

## ภาพรวม

```text
Bot บน Server 2
      │
      ├─ แยกประเภทงาน SEND / POLL / WARM
      ├─ ตรวจ local lanes ของ worker นั้น
      ├─ เปรียบเทียบ SEND/POLL RTT จริงตาม role
      └─ เลือกเพียง 1 lane
                    │
                    ▼
          legy.line-apps.com
                    │
                 Akamai
                    │
                    ▼
                  LINE
```

- `NETWORK · LINE ↔ AKAMAI` แสดงสถานะ connection และค่าปัจจุบัน
- `LANE RACE` แสดงคะแนนและประวัติผลงานของแต่ละ lane
- เป้าหมาย SEND ต่ำกว่า `20ms`; lane ที่ช้ากว่า lane เร็วที่สุดในกลุ่ม (เกิน `1.5×` หรือเกินเพดาน `28ms` แล้วแต่อันไหนแคบกว่า) จะพักชั่วคราวเมื่อมีทางเลือก
- แต่ละ request ใช้เพียงหนึ่ง lane เพื่อป้องกันข้อความซ้ำ

## โครงสร้าง Server 2

| Worker  | ที่อยู่  | Lane source | จำนวน lane |
| ------- | -------- | ----------- | ----------: |
| Primary | Server 2 | Local       |          16 |

## NETWORK · LINE ↔ AKAMAI

### สถานะ lane

| สถานะ             | ความหมาย                                  |
| ----------------- | ----------------------------------------- |
| `พร้อม`           | HTTP/2 session ใช้งานได้                  |
| `กำลังต่อ`        | กำลังเปิด DNS/TCP/TLS/HTTP2               |
| `กำลังปิด`        | ได้รับ GOAWAY หรือกำลังรอให้งานค้างจบ     |
| `ตาย`             | Connection ใช้งานไม่ได้และกำลัง reconnect |
| `ว่าง`            | ไม่มี request ค้างอยู่                    |
| `กำลังส่ง N คำขอ` | มี HTTP/2 stream ทำงานพร้อมกัน N รายการ   |

สีเขียวหมายถึงพร้อมหรือเป็น route ที่เลือกอยู่ สีเหลืองหมายถึงกำลังเชื่อมหรือคำเตือน และสีแดงสงวนไว้สำหรับ connection failure ไม่ได้ใช้ตัดสินจากตัวเลข RTT

### PING

`PING` วัดเฉพาะเส้นทางจาก Server 2 ไปยัง HTTP/2 socket หรือ Akamai edge

```text
Server 2 ↔ Network ↔ Akamai edge
```

PING ไม่รวม:

- การประมวลผลภายใน LINE
- การตรวจ token/session
- Thrift protocol
- การส่งข้อความหรือ poll จริง
- เวลาที่ LINE ใช้สร้าง response

ดังนั้น `PING 1.4ms` และ `จริง 28.3ms` สามารถเกิดพร้อมกันได้โดยไม่ถือว่าผิดปกติ

ระบบ PING ทุก 15 วินาที และใช้ EWMA:

```text
PING ใหม่ = PING เดิม × 0.70 + ตัวอย่างใหม่ × 0.30
```

### อุ่นแล้ว · รองานจริง

ตอนเริ่มระบบและหลัง reconnect ทุก lane จะ:

1. เปิด DNS/TCP/TLS/HTTP2
2. ส่ง PING
3. ส่ง `HEAD /SQ1`
4. เตรียม Akamai/application path
5. เก็บ TLS session ticket สำหรับ reconnect

`HEAD /SQ1` ไม่มี LINE token และไม่มีข้อความ จึงไม่ถูกนับเป็น SEND/POLL RTT

`อุ่นแล้ว · รองานจริง` หมายถึง connection พร้อม แต่ยังไม่มี SEND หรือ POLL จริงผ่าน lane หลังจากเปิด connection รอบล่าสุด ไม่ได้หมายความว่า lane เสีย

### ค่างานจริง

ระบบแยก measurement เป็นสามประเภท:

| ค่า                | ความหมาย                                        | ใช้เลือก SEND หรือไม่ |
| ------------------ | ----------------------------------------------- | --------------------- |
| `rttMs`            | HTTP/2 PING                                     | ไม่ใช้เป็น SEND จริง  |
| `sendRttMs`        | SEND จริง                                       | ใช้                   |
| `pollRttMs`        | POLL จริง                                       | ไม่ใช้แทน SEND        |
| `applicationRttMs` | ค่าของ SEND/POLL role ที่มีผลล่าสุดสำหรับหน้าจอ | ใช้แสดงผลเท่านั้น     |

POLL ใช้ median ของผลล่าสุดสูงสุดเจ็ดครั้ง เพื่อกรอง spike เดี่ยว แต่ยังตอบสนองเมื่อเส้นทางช้าติดต่อกัน SEND ไม่ใช้ median เฉย ๆ อีกต่อไป แต่ทำนาย completion time จากหน้าต่างเจ็ดผลล่าสุด **แยกต่อบอท** (ดูหัวข้อ "กฎเลือก SEND lane")

### สีของค่าจริง

- เขียว: เป็น SEND route ที่เร็วที่สุดและไม่อยู่ใน cooldown (`routingPreferred`)
- เทา/ปกติ: มีผลจริงแล้ว แต่เป็น standby
- ไม่มีค่าจริง: อุ่นแล้วแต่ยังไม่มี SEND/POLL จริง
- แดง: connection failure ไม่ได้หมายถึง RTT สูง

ค่าต่ำกว่า `20ms` คือเป้าหมาย ไม่ใช่การแต่งสีให้ผ่าน หากทุก route ช้าพร้อมกัน ค่า `จริง 28.3ms` ยังอาจเป็นสีเขียวได้เมื่อเป็นค่าต่ำที่สุด เพราะระบบต้องส่งต่อแทนการทิ้งข้อความ

## กฎเลือก SEND lane

ทุก bot มี route key ของตัวเอง (`x-linebot-lane-route-key`, ใช้ภายในกระบวนการเท่านั้น — ไม่ถึง LINE) แต่ละ lane เก็บ SEND history แยกต่อ bot route key ไม่ใช่แยกต่อ origin เฉยๆ อีกต่อไป คะแนนของ lane ต่อ bot หนึ่งตัวคือ **predicted completion time**:

```text
predicted completion = p50 + (p95 - p50) × 0.35 + queue waves × p50

p50/p95   = จากหน้าต่างผลจริงล่าสุดสูงสุด 7 ครั้งของบอทนั้นบน lane นั้น
            (ถ้าบอทนั้นยังไม่มีผลสดบน lane นี้ ใช้ prior ของ lane แทนเพื่อ bootstrap)
queue waves = floor(inFlight / maxConcurrentStreams ที่ peer ประกาศจริงผ่าน HTTP/2 SETTINGS)
```

ไม่มี penalty เดา เช่น `inFlight × 4ms` คิว cost เกิดเฉพาะเมื่อ HTTP/2 concurrency ของ lane นั้นเต็มจริง

ตัวอย่าง:

| Lane | p50 (บอทนี้) | p95 (บอทนี้) | Predicted | หมายเหตุ                                      |
| ---- | -----------: | -----------: | --------: | --------------------------------------------- |
| A    |         15ms |         48ms |   ~26.6ms | median ต่ำแต่ jitter สูง (เคย spike ถึง 48ms) |
| B    |         17ms |         18ms |   ~17.4ms | นิ่งกว่า ชนะแม้ median สูงกว่า A              |

ระบบเลือก Lane B เพราะ predicted completion ต่ำที่สุด ไม่ใช่แค่ median ต่ำที่สุด `inFlight` ใช้ตัดสินเฉพาะเมื่อ predicted score เท่ากันพอดี

บอทแต่ละตัวสามารถชนะคนละ lane กันได้ในเวลาเดียวกัน และ cooldown ของบอทหนึ่งจะพักเฉพาะ bot-route นั้นบน lane นั้น ไม่ลาม lane ทิ้งไปทั้งกลุ่มสำหรับบอทอื่น bot-route profile หมดอายุหลัง **15 นาที** ไม่มีผลจริงใหม่ (traffic SEND จริงต่อ 1 บอท/ห้องห่างกันเป็นนาที — 30 วินาทีเดิมทำให้ predictor ไม่เคยสด) แล้ว fallback กลับไปใช้ prior ของ lane

### Round-robin ระหว่าง lane ที่เสมอกัน

เมื่อมีหลาย lane ที่คะแนน predicted อยู่ในระยะ switch margin `0.1ms` จากตัวเร็วสุด (กรณีปกติ เพราะ lane ทั้งกลุ่มวิ่งไปยัง IP เร็วชุดเดียวกัน) ระบบ **หมุนเวียน** SEND ไปทีละ lane ต่อ bot route key แทนที่จะให้ lane id ต่ำสุดรับงานทั้งหมด — เพื่อให้ทุก lane มี traffic และมี sample สด ถ้ามี lane ที่เร็วกว่าจริงเกิน margin lane นั้นชนะเดี่ยว ๆ ไม่เข้าการหมุนเวียน

```text
lane 0/1/2 คะแนน 19.0 / 19.0 / 19.05ms → SEND หมุน 0 → 1 → 2 → 0 …
lane 0 คะแนน 18ms, lane 1 คะแนน 25ms → lane 0 รับทุกครั้ง
```

### Lane ที่ยังไม่มี SEND sample

ระบบไม่ถือว่า lane เร็วเพียงเพราะ PING ต่ำ (PING จบที่ Akamai edge ~1–3ms ไม่ใช่ RPC จริง):

```text
cold lane = ไม่มีสิทธิ์ชนะ lane ที่มี SEND measurement จริง
จัดอันดับ cold lane ด้วย median HTTPS ต่อ IP (legy-ip-rank.json จาก pin-legy-fast-ips.sh) ไม่ใช่ PING
```

ถ้า measured route อยู่ใน cooldown ทั้งหมด ระบบจึงให้ cold lane ที่พร้อมอยู่รับงานหนึ่งครั้งเพื่อสร้าง SEND sample โดยไม่ส่งข้อความซ้ำ

### Guardrail — cooldown แบบ relative

- ต่ำกว่า 20ms: เป้าหมายปกติ
- lane cool เมื่อผลเกิน `min(28ms, 1.5 × lane เร็วสุดที่วัดได้ในกลุ่ม)` — เพดานคงที่ 23ms เดิมต่ำกว่า p50 จริงเลย cool เกือบทุก send จน ranking พัง; ถ้าไม่มี sibling ที่วัดได้ใช้เพดาน `28ms` อย่างเดียว
- พัก 15 วินาที เฉพาะ **bot-route** นั้นบน lane นั้น ไม่ใช่ทั้ง lane สำหรับบอทอื่น
- ถ้าทุก route พักพร้อมกัน: ใช้ SEND RTT ต่ำที่สุดต่อเพื่อไม่ทิ้งข้อความ
- ผลเร็วครั้งถัดไปของบอทนั้นล้าง cooldown ของบอทนั้นทันที
- knob: `LINE_H2_SEND_SLOW_FLOOR_MS` (28), `LINE_H2_SEND_SLOW_RATIO` (1.5), `LINE_H2_SEND_ROUTE_SAMPLE_MAX_AGE_MS` (900000)

## กฎเลือก POLL lane

1. เลือก lane ที่ยังไม่มี `pollRttMs`
2. เริ่มจาก lane ที่ PING ต่ำที่สุดในกลุ่มที่ยังไม่วัด (POLL ยังใช้ PING เป็น prior เพราะ POLL เป็น read path สั้น ไม่เหมือน SEND ที่ใช้ IP ranking)
3. ให้ POLL จริงหนึ่งงานผ่าน lane
4. ทำซ้ำจน lane ได้รับการ calibrate
5. หลัง calibrate เลือก lane ที่ `pollRttMs` ต่ำที่สุด
6. ถ้า POLL RTT เท่ากันจึงใช้ in-flight เป็นตัวตัดสิน

POLL มี switch margin `0.1ms` สำหรับการเปรียบเทียบ local lane และบันทึก LANE RACE สูงสุดหนึ่งตัวอย่างต่อ lane ต่อนาที เพื่อลดงานฐานข้อมูล

## การแบ่ง SEND/POLL lane

ค่าปัจจุบันสำรอง lane หมายเลขต่ำสี่ lane สำหรับ SEND:

```text
lane 0–3   → SEND preference
lane 4–N   → POLL preference
```

เป็น preference ไม่ใช่ข้อบังคับ หาก lane ในกลุ่มหนึ่งล่มทั้งหมด ระบบสามารถใช้ usable lane จากอีกกลุ่มได้

SEND profile แยกต่อ bot route key มีอายุ **15 นาที** (`LINE_H2_SEND_ROUTE_SAMPLE_MAX_AGE_MS`) แล้ว fallback ไปใช้ prior ของ local lane แทน

## การป้องกันข้อความซ้ำ

```text
คำนวณคะแนน
→ เลือก 1 lane
→ ส่ง 1 ครั้ง
```

- หาก connection ตายก่อน request ออกจากเครื่อง สามารถ fallback ได้อย่างปลอดภัย
- หาก request ออกไปแล้วแต่ response ขาด ระบบไม่ retry ไป lane อื่น เพราะไม่ทราบว่า LINE รับข้อความแล้วหรือไม่
- เมื่อได้รับ GOAWAY lane จะหยุดรับงานใหม่ แต่งานเดิมจบก่อน
- ระบบไม่มีการ hedge หรือยิงข้อความเดียวกันแข่งหลายเส้นทาง

## การซ่อม lane

เมื่อ lane เสีย ระบบจะ:

1. เปลี่ยนสถานะเป็น `dead`
2. ล้าง PING/SEND/POLL measurement ของ connection เก่า
3. reconnect ด้วย backoff เริ่มประมาณ 250ms สูงสุด 8 วินาที
4. PING ใหม่
5. ทำ `HEAD /SQ1` ใหม่
6. กลับเข้าสู่การแข่งขันเป็น connection ใหม่

มี rolling recycle เพิ่มเติม:

- lane อายุประมาณ 15 นาทีมีสิทธิ์ถูกเปลี่ยน
- เปลี่ยนทีละหนึ่ง lane
- เว้นอย่างน้อย 60 วินาที
- เปลี่ยนเฉพาะ lane ที่ไม่มี in-flight
- ต้องมี standby ใน partition เดียวกัน

## LANE RACE

LANE RACE เป็นระบบคะแนนและประวัติ ไม่ใช่ตัวตัดสิน route หลัก การเลือก route ใช้ SEND/POLL measurement ปัจจุบัน ส่วนคะแนนใช้วิเคราะห์แนวโน้มย้อนหลัง

### FASTEST / STANDBY / WAIT

| สถานะ     | ความหมาย                                       |
| --------- | ---------------------------------------------- |
| `FASTEST` | SEND lane ที่ได้คะแนนดีที่สุดใน worker นั้น    |
| `STANDBY` | มีงานจริงแล้ว แต่ไม่ได้เป็นผู้ชนะปัจจุบัน      |
| `WAIT`    | Connection อุ่นแล้ว แต่ยังไม่มี SEND/POLL จริง |

### ดาวและกล้วย

ระบบหา benchmark จาก lane ที่มี RTT ต่ำที่สุดของ role เดียวกัน

```text
RTT ของงานนี้ ≤ benchmark + 1.5ms → ⭐
RTT ของงานนี้ > benchmark + 1.5ms → 🍌
ทุก 10 ดาว → 🌟 1 ดวง
```

ตัวอย่าง benchmark SEND เท่ากับ `18ms`:

|    RTT | คะแนน |
| -----: | ----- |
| 17.5ms | ⭐    |
| 18.0ms | ⭐    |
| 19.4ms | ⭐    |
| 19.5ms | ⭐    |
| 19.6ms | 🍌    |
|   30ms | 🍌    |

ดาวและกล้วยเป็นสถิติ ไม่มีผลเพิ่มสิทธิ์หรือบังคับ routing และไม่มีเกณฑ์ต่ำกว่า `20ms`

SEND และ POLL มีตารางคะแนนแยกกัน ห้ามใช้คะแนน POLL สรุปว่า SEND ของ lane นั้นเร็ว

### Average RTT

`avgRttMs` เป็นค่าเฉลี่ยประวัติ ใช้ดูแนวโน้มระยะยาว แต่ routing ของ SEND ใช้ predicted completion จากหน้าต่างผลจริงล่าสุดสูงสุดเจ็ดครั้งต่อบอท (ดูหัวข้อ "กฎเลือก SEND lane") ส่วน POLL ยังใช้ median ของผลล่าสุดสูงสุดเจ็ดครั้ง

ดังนั้นค่าต่อไปนี้สามารถเกิดพร้อมกันได้:

```text
LANE RACE average = 30ms
Network จริงล่าสุด = 18ms
```

หมายถึง lane เคยช้าในอดีต แต่ปัจจุบันดีขึ้นแล้ว

## LANE + LATENCY LOG

รายการ lane แสดง:

```text
เวลา · SEND/POLL · Lane · Origin · ⭐/🍌 · RTT
```

รายการ bot latency แสดง:

| ค่า     | ความหมาย                                     |
| ------- | -------------------------------------------- |
| `IN`    | เวลารอรับ event ก่อนเข้าโค้ด                 |
| `CODE`  | Rule matching, E2EE และ protocol preparation |
| `LINE`  | เวลาตั้งแต่ dispatch จนได้ response จาก LINE |
| `TOTAL` | เวลารวมของการตอบข้อความ                      |

ตัวอย่าง:

```text
Lane SEND RTT 20ms
CODE 4ms
IN 8ms
TOTAL ประมาณ 32ms
```

LANE RTT จึงไม่จำเป็นต้องเท่ากับ TOTAL

## รอบการอัปเดตและการเก็บข้อมูล

| รายการ                       | รอบเวลา/ระยะเก็บ                 |
| ---------------------------- | -------------------------------- |
| HTTP/2 PING                  | ทุก 15 วินาที                    |
| Network panel                | ทุก 5 วินาที                     |
| LANE RACE panel              | ทุก 15 วินาที                    |
| POLL race persistence        | สูงสุดหนึ่งครั้งต่อ lane ต่อนาที |
| ประวัติ Server 2             | 30 วันโดยค่าเริ่มต้น             |
| Recent lane events ใน memory | 240 รายการ                       |

การบันทึกคะแนนทำหลัง response จบผ่าน `setImmediate` และ write-behind worker จึงไม่ขวางเส้นทางตอบข้อความ

## สรุปความหมายสั้น ๆ

```text
PING       = connection ไป Akamai เร็วแค่ไหน
SEND RTT   = ส่งผ่าน LINE จริงเร็วแค่ไหน
POLL RTT   = รับ event จาก LINE จริงเร็วแค่ไหน
FASTEST    = SEND lane ที่ระบบเลือกอยู่ใน worker นั้น
STANDBY    = วัดแล้ว แต่มีตัวเลือกที่เหมาะสมกว่า
WAIT       = อุ่นแล้ว แต่ยังไม่มีงานจริง
⭐         = ผลงานใกล้ benchmark ไม่เกิน 1.5ms
🍌         = ช้ากว่า benchmark เกิน 1.5ms
🌟         = ดาวสะสมครบทุก 10 ดวง
```

ระบบเลือกได้เฉพาะเส้นทางที่มีข้อมูลปัจจุบันดีที่สุด แต่ไม่สามารถรับประกันว่า request ถัดไปจะไม่เกิด network jitter หรือความล่าช้าภายใน LINE/Akamai ได้
