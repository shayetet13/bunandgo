# NETWORK · LINE ↔ AKAMAI และ LANE RACE

เอกสารนี้สรุปการทำงานของระบบ network lane ที่ใช้งานจริงบน Server 2 และ Server 3

## ภาพรวม

```text
Bot บน Server 2
      │
      ├─ แยกประเภทงาน SEND / POLL / WARM
      ├─ ตรวจ local lanes บน Server 2
      ├─ ตรวจ remote candidate จาก Server 3
      ├─ เปรียบเทียบ SEND/POLL RTT จริงตาม role
      └─ เลือกเพียง 1 server และ 1 lane
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
- เป้าหมาย SEND ต่ำกว่า `20ms`; ผลเกิน `23ms` ทำให้ route พักชั่วคราวเมื่อมีทางเลือก
- แต่ละ request ใช้เพียงหนึ่ง server และหนึ่ง lane เพื่อป้องกันข้อความซ้ำ

## โครงสร้าง Server 2/3

| Worker | ที่อยู่ | Lane source | จำนวน lane |
|---|---|---|---:|
| Primary | Server 2 | Local และมี Server 3 เป็น remote candidate | 16 local + 32 remote |
| Shard B | Server 2 | Local และมี Server 3 เป็น remote candidate | 16 local + 32 remote |
| Lane Relay | Server 3 | เชื่อม `legy.line-apps.com` | 32 |

Server 3 ไม่มี bot, login, LINE session หรือฐานข้อมูล และไม่รับ `gf.line.naver.jp`

## NETWORK · LINE ↔ AKAMAI

### สถานะ lane

| สถานะ | ความหมาย |
|---|---|
| `พร้อม` | HTTP/2 session ใช้งานได้ |
| `กำลังต่อ` | กำลังเปิด DNS/TCP/TLS/HTTP2 |
| `กำลังปิด` | ได้รับ GOAWAY หรือกำลังรอให้งานค้างจบ |
| `ตาย` | Connection ใช้งานไม่ได้และกำลัง reconnect |
| `ว่าง` | ไม่มี request ค้างอยู่ |
| `กำลังส่ง N คำขอ` | มี HTTP/2 stream ทำงานพร้อมกัน N รายการ |

สีเขียวหมายถึงพร้อมหรือเป็น route ที่เลือกอยู่ สีเหลืองหมายถึงกำลังเชื่อมหรือคำเตือน และสีแดงสงวนไว้สำหรับ connection failure ไม่ได้ใช้ตัดสินจากตัวเลข RTT

### PING

`PING` วัดเฉพาะเส้นทางจาก Server 2/3 ไปยัง HTTP/2 socket หรือ Akamai edge

```text
Server 2/3 ↔ Network ↔ Akamai edge
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

| ค่า | ความหมาย | ใช้เลือก SEND หรือไม่ |
|---|---|---|
| `rttMs` | HTTP/2 PING | ไม่ใช้เป็น SEND จริง |
| `sendRttMs` | SEND จริง | ใช้ |
| `pollRttMs` | POLL จริง | ไม่ใช้แทน SEND |
| `applicationRttMs` | ค่าของ SEND/POLL role ที่มีผลล่าสุดสำหรับหน้าจอ | ใช้แสดงผลเท่านั้น |

SEND และ POLL ใช้ median ของผลล่าสุดสูงสุดสามครั้งแยกกัน เพื่อกรอง spike เดี่ยว แต่ยังตอบสนองเมื่อเส้นทางช้าติดต่อกัน

### สีของค่าจริง

- เขียว: เป็น SEND route ที่เร็วที่สุดและไม่อยู่ใน cooldown (`routingPreferred`)
- เทา/ปกติ: มีผลจริงแล้ว แต่เป็น standby
- ไม่มีค่าจริง: อุ่นแล้วแต่ยังไม่มี SEND/POLL จริง
- แดง: connection failure ไม่ได้หมายถึง RTT สูง

ค่าต่ำกว่า `20ms` คือเป้าหมาย ไม่ใช่การแต่งสีให้ผ่าน หากทุก route ช้าพร้อมกัน ค่า `จริง 28.3ms` ยังอาจเป็นสีเขียวได้เมื่อเป็นค่าต่ำที่สุด เพราะระบบต้องส่งต่อแทนการทิ้งข้อความ

## กฎเลือก SEND lane

คะแนนของ lane ที่มี SEND measurement แล้ว:

```text
SEND score = median SEND RTT 3 ครั้งล่าสุด
```

ตัวอย่าง:

| Lane | SEND RTT | In-flight | Score |
|---|---:|---:|---:|
| A | 18ms | 0 | 18ms |
| B | 15ms | 1 | 15ms |
| C | 21ms | 0 | 21ms |

ระบบเลือก Lane B เพราะ SEND RTT จริงต่ำที่สุด `inFlight` ใช้ตัดสินเฉพาะเมื่อ RTT เท่ากันพอดี

### Soft affinity

ระบบมี switch margin `0.1ms` เพื่อให้ความต่างระดับเสี้ยว millisecond มีผลต่อผู้ชนะ โดยยังไม่สลับเมื่อค่าต่างกันต่ำกว่า `0.1ms`

```text
เดิม 18.0ms / ใหม่ 17.91ms / ต่าง 0.09ms → อยู่ lane เดิม
เดิม 18.0ms / ใหม่ 17.90ms / ต่าง 0.10ms → ย้ายได้
```

นี่ไม่ใช่การล็อก lane ถาวร เพราะทุก request จะคำนวณใหม่

### Lane ที่ยังไม่มี SEND sample

ระบบไม่ถือว่า lane เร็วเพียงเพราะ PING ต่ำ:

```text
cold lane = ไม่มีสิทธิ์ชนะ lane ที่มี SEND measurement จริง
```

ถ้า measured route อยู่ใน cooldown ทั้งหมด ระบบจึงให้ cold lane ที่พร้อมอยู่รับงานหนึ่งครั้งเพื่อสร้าง SEND sample โดยไม่ส่งข้อความซ้ำ

### Guardrail 20/23ms

- ต่ำกว่า 20ms: เป้าหมายปกติ
- 20–23ms: ยังใช้งานได้ แต่แพ้ค่าที่ต่ำกว่าเสมอ
- มากกว่า 23ms: พัก 15 วินาทีเมื่อมี route อื่น
- ถ้าทุก route พักพร้อมกัน: ใช้ SEND RTT ต่ำที่สุดต่อเพื่อไม่ทิ้งข้อความ

## กฎเลือก POLL lane

1. เลือก lane ที่ยังไม่มี `pollRttMs`
2. เริ่มจาก lane ที่ PING ต่ำที่สุดในกลุ่มที่ยังไม่วัด
3. ให้ POLL จริงหนึ่งงานผ่าน lane
4. ทำซ้ำจน lane ได้รับการ calibrate
5. หลัง calibrate เลือก lane ที่ `pollRttMs` ต่ำที่สุด
6. ถ้า POLL RTT เท่ากันจึงใช้ in-flight เป็นตัวตัดสิน

POLL มี switch margin `0.1ms` สำหรับการเปรียบเทียบ local/remote และบันทึก LANE RACE สูงสุดหนึ่งตัวอย่างต่อ lane ต่อนาที เพื่อลดงานฐานข้อมูล

## การแบ่ง SEND/POLL lane

ค่าปัจจุบันสำรอง lane หมายเลขต่ำสี่ lane สำหรับ SEND:

```text
lane 0–3   → SEND preference
lane 4–N   → POLL preference
```

เป็น preference ไม่ใช่ข้อบังคับ หาก lane ในกลุ่มหนึ่งล่มทั้งหมด ระบบสามารถใช้ usable lane จากอีกกลุ่มได้

## การแข่งขันระหว่าง Server 2 และ Server 3

Server 3 ส่งรายงานกลับ Server 2 ทุกหนึ่งวินาที ประกอบด้วย:

- สถานะ lane
- PING
- SEND RTT
- POLL RTT
- In-flight
- Failure count
- LANE RACE score

ถ้ารายงานเก่ากว่าสามวินาที Server 3 จะถูกถอดออกจาก candidate และหายจากหน้าจอจนกว่าจะมีรายงานใหม่

SEND/POLL sample ที่เก่ากว่าประมาณ 30 วินาทีจะไม่ถูกอ้างว่าเป็นค่าปัจจุบัน

เมื่อ Primary ส่งผ่าน Server 3 ระบบวัดแบบ end-to-end:

```text
Server 2 → WireGuard → Server 3 → Akamai → LINE
→ Server 3 → WireGuard → Server 2
```

ค่านี้มีความสำคัญกว่าค่าที่ Server 3 วัดตัวเอง เพราะเป็นเวลาที่ bot บน Server 2 พบจริง

## การป้องกันข้อความซ้ำ

```text
คำนวณคะแนน
→ เลือก 1 server
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

| สถานะ | ความหมาย |
|---|---|
| `FASTEST` | SEND lane ที่ได้คะแนนดีที่สุดใน worker นั้น |
| `STANDBY` | มีงานจริงแล้ว แต่ไม่ได้เป็นผู้ชนะปัจจุบัน |
| `WAIT` | Connection อุ่นแล้ว แต่ยังไม่มี SEND/POLL จริง |

### ดาวและกล้วย

ระบบหา benchmark จาก lane ที่มี RTT ต่ำที่สุดของ role เดียวกัน

```text
RTT ของงานนี้ ≤ benchmark + 1.5ms → ⭐
RTT ของงานนี้ > benchmark + 1.5ms → 🍌
ทุก 10 ดาว → 🌟 1 ดวง
```

ตัวอย่าง benchmark SEND เท่ากับ `18ms`:

| RTT | คะแนน |
|---:|---|
| 17.5ms | ⭐ |
| 18.0ms | ⭐ |
| 19.4ms | ⭐ |
| 19.5ms | ⭐ |
| 19.6ms | 🍌 |
| 30ms | 🍌 |

ดาวและกล้วยเป็นสถิติ ไม่มีผลเพิ่มสิทธิ์หรือบังคับ routing และไม่มีเกณฑ์ต่ำกว่า `20ms`

SEND และ POLL มีตารางคะแนนแยกกัน ห้ามใช้คะแนน POLL สรุปว่า SEND ของ lane นั้นเร็ว

### Average RTT

`avgRttMs` เป็นค่าเฉลี่ยประวัติ ใช้ดูแนวโน้มระยะยาว แต่ routing ใช้ median ของผลล่าสุดสูงสุดสามครั้ง

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

| ค่า | ความหมาย |
|---|---|
| `IN` | เวลารอรับ event ก่อนเข้าโค้ด |
| `CODE` | Rule matching, E2EE และ protocol preparation |
| `LINE` | เวลาตั้งแต่ dispatch จนได้ response จาก LINE |
| `TOTAL` | เวลารวมของการตอบข้อความ |

ตัวอย่าง:

```text
Lane SEND RTT 20ms
CODE 4ms
IN 8ms
TOTAL ประมาณ 32ms
```

LANE RTT จึงไม่จำเป็นต้องเท่ากับ TOTAL

## รอบการอัปเดตและการเก็บข้อมูล

| รายการ | รอบเวลา/ระยะเก็บ |
|---|---|
| HTTP/2 PING | ทุก 15 วินาที |
| Server 3 report | ทุก 1 วินาที |
| Network panel | ทุก 5 วินาที |
| LANE RACE panel | ทุก 15 วินาที |
| POLL race persistence | สูงสุดหนึ่งครั้งต่อ lane ต่อนาที |
| ประวัติ Server 2 | 30 วันโดยค่าเริ่มต้น |
| Recent lane events ใน memory | 240 รายการ |

Server 3 ไม่มีฐานข้อมูล คะแนน LANE RACE ของ Server 3 จึงเริ่มใหม่เมื่อ relay restart

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
