# linejs-core — ชิ้นส่วนที่ต้องเก็บถ้าจะเขียนเอง

> อ้างอิงจากโค้ดจริงใน `backend/src/linejs-core/` (fork ที่ vendor + แก้เองแล้ว)
> เป้าหมายเอกสารนี้: ให้เขียน client ใหม่แบบ **strip-down** ได้โดยไม่ต้อง reverse โปรโตคอลซ้ำ

---

## 0. สรุปการตัดสินใจก่อนเริ่ม

**อย่าเขียนจากศูนย์ — ให้ strip-down จาก fork ที่มีอยู่**

เหตุผล: 90% ของงาน reverse-engineering ทำเสร็จแล้วและ vendor อยู่ในเรโปนี้ 3 ไฟล์:

| ไฟล์ | บรรทัด | คืออะไร |
|---|---|---|
| `types/thrift.ts` | ~39,000 | **rename table** — map `field id → field name` ของทุก struct (ตัวที่ `rename_data()` ใช้แปลง response ดิบเป็น object ที่อ่านได้) |
| `types/line_types.ts` | ~20,000 | TS type ของทุก struct/enum ของ LINE |
| `base/thrift/readwrite/struct.ts` | ~7,300 | `LINEStruct.*` — ตัวสร้าง argument (`NestedArray`) ของทุก RPC |

ทั้งสามไฟล์นี้ = "linejs" ตัวจริง reference ผ่าน path alias ใน `backend/tsconfig.json`:
```jsonc
"@evex/linejs-types":        ["./src/linejs-core/types/line_types.ts"],
"@evex/linejs-types/thrift": ["./src/linejs-core/types/thrift.ts"],
"@evex/loose-types":         ["./src/linejs-core/types/loose-types.ts"]
```
**เก็บทั้ง 3 ไฟล์ไว้เหมือนเดิม** ไม่ต้องเข้าใจข้างในมันด้วยซ้ำ — แค่ต้องมี machinery ที่เรียกใช้มันถูก

**external dependency ที่เลี่ยงไม่ได้** (อยู่ใน `backend/package.json` แล้ว):

| แพ็กเกจ | ใช้ทำอะไร | เขียนเองแทนได้ไหม |
|---|---|---|
| `thrift` (Apache Thrift JS) | `TCompactProtocol`, `TBinaryProtocol`, `TBufferedTransport`, `TFramedTransport` | ได้ แต่ ~800 บรรทัดและไม่คุ้ม |
| `node-int64` | เขียน I64 ลง wire (LINE ใช้ message id เป็น 64-bit) | ต้องมี — มีกับดัก (ดู §7) |
| `@noble/ciphers` + `curve25519-js` + `tweetnacl` | E2EE (X25519 + AES-GCM) | เฉพาะถ้าต้องรองรับ Talk E2EE |

---

## 1. สถาปัตยกรรมชั้น (เขียนจากล่างขึ้นบน)

```
┌─ client/client.ts ............ Client class: listen(), sendCompactMessage(), event emitter
│  └─ client/features/message/{square,talk}.ts .. SquareMessage / TalkMessage wrapper
├─ base/core/mod.ts ............ BaseClient: ประกอบทุก service, ถือ authToken, reqseq, fetch/fetchHot
│  ├─ base/login/mod.ts ........ QR / token login
│  ├─ base/service/square/mod.ts .. sendMessage / fetchSquareChatEvents / fetchMyEvents
│  ├─ base/service/talk/mod.ts .... sendCompactMessage / sync / noop / getProfile
│  ├─ base/push/{connManager,conn}.ts .. LEGY H2 PUSH stream
│  ├─ base/polling/mod.ts ...... initLegyPusher loop + stop()
│  └─ base/e2ee/mod.ts ......... (เฉพาะ Talk E2EE)
├─ base/request/mod.ts ......... RPC engine: สร้าง header, เลือก transport, parse response, refresh token
│  ├─ base/request/legy.ts ..... LEGY encrypted transport (/S3,/S4,/SYNC,... = auth ที่เข้ารหัสอีกชั้น)
│  └─ base/request/auth_token.ts . แยกชนิด token (JWT / primary / authKey)
├─ base/thrift/ ................ codec: write.ts, read.ts, rename/parser.ts + declares.ts (NestedArray)
├─ base/storage/base.ts ........ interface KV (get/set/delete) — impl เป็นของโปรเจคเอง
└─ base/core/utils/devices.ts .. app version / systemName ที่ emulate
```

**กฎ:** ชั้นล่างไม่ import ชั้นบน ยกเว้นจุดเดียว — `base/core/mod.ts` import `dispatch/direct-request.ts` (จุดต่อระบบความเร็ว ดู §4)

---

## 2. ตารางชิ้นส่วน — เก็บ / ย่อ / ทิ้ง

| โมดูล | สถานะ | หมายเหตุ |
|---|---|---|
| `base/thrift/readwrite/{write,read,declares}.ts` | **เก็บทั้งหมด** | codec หัวใจ ~500 บรรทัด |
| `base/thrift/rename/parser.ts` | **เก็บ** | 73 บรรทัด — แปลง fid→name; จุด optimize ได้ (ดู §7) |
| `base/thrift/readwrite/struct.ts` | **เก็บทั้งหมด** | 7.3k บรรทัด generated — ไม่ต้องอ่าน |
| `base/thrift/readwrite/tmc.ts` | เก็บ | `TMoreCompactProtocol` — push อ่าน sync response ด้วยตัวนี้ |
| `base/request/mod.ts` | **เก็บ ย่อได้** | ตัด `EXCEPTION_TYPES` ที่ไม่ใช้ออกได้ |
| `base/request/legy.ts` | **เก็บทั้งหมด** | crypto constant re-derive ไม่ได้ |
| `base/request/auth_token.ts` | **เก็บ** | logic แยกชนิด token |
| `base/login/mod.ts` | **เก็บเฉพาะ QR v2 ForSecure** | ตัด `requestEmailLogin*`, `requestSQR` (v1) ทิ้งได้ |
| `base/login/{rsa-verify,regex,transient}.ts` | เก็บเท่าที่ login เรียก | |
| `base/service/square/mod.ts` | **เก็บ ~6 method** | `sendMessage`, `fetchSquareChatEvents`, `fetchMyEvents`, `getJoinedSquares`, `getSquareChat`, `getSquareChatMembers`, (+ `destroyMessage`/`unsendMessage` ถ้าใช้ guardrail) — ที่เหลือ ~80 method ทิ้ง |
| `base/service/talk/mod.ts` | **เก็บ ~6 method** | `sendCompactMessage`(+ตระกูล), `sync`, `noop`, `getProfile`, `getContactsV2/V3`, `negotiateE2EEPublicKey` — ที่เหลือ ~120 method ทิ้ง |
| `base/service/talk/compact.ts` | **เก็บทั้งหมด** | 248 บรรทัด — encoder /CA5 /ECA5 |
| `base/push/connManager.ts` | **เก็บ** | 779 บรรทัด — ตัด branch serviceType 5/8 (Talk push) ได้ถ้าใช้แต่ Square |
| `base/push/{conn,connData,rearm_policy}.ts` | **เก็บ** | H2 framing |
| `base/polling/mod.ts` | **เก็บ `initLegyPusher` + `stop()` + `listen*Events`** | ตัด `_listenSquareEvents`/`_listenTalkEvents` (deprecated) ทิ้ง |
| `base/e2ee/mod.ts` | **เก็บถ้าต้อง Talk E2EE** | 1,138 บรรทัด — ตัดได้หมดถ้าบอททำแต่ Square (Square ไม่มี E2EE) |
| `base/storage/base.ts` + impl | **เก็บ interface** | impl = ของโปรเจค (RAM Map + write-behind) |
| `base/core/utils/devices.ts` | **เก็บ** | ต้อง bump `appVersion` เองเป็นระยะ |
| `base/core/typed-event-emitter/` | เก็บ | 56 บรรทัด |
| `base/async-queue.ts` | **เก็บ** | `#squareFetchQueue` ใช้กัน race (ดู §7) |
| `client/client.ts` | **เก็บ ย่อหนัก** | เก็บ `listen()`, `sendCompactMessage()`, `authToken` getter — ตัด voom/liff/profile/fetchUsers ฯลฯ |
| `client/features/message/{square,talk}.ts` | **เก็บ** | wrapper `SquareMessage`/`TalkMessage` ที่ handler ใช้ |
| `base/{timeline,obs}/`, `base/service/{call,channel,shop,liff,coin,livetalk,buddy,...}` | **ทิ้งทั้งหมด** | ~40 โฟลเดอร์ ดู §5 |

---

## 3. รายละเอียดแต่ละชั้น

### 3.1 Thrift codec (`base/thrift/`)

**Protocol map** (`declares.ts`):
```ts
Protocols = { 3: TBinaryProtocol, 4: TCompactProtocol }
```
- Talk / login = protocol **3** (binary) บน `/S3`, `/S4`, `/SYNC4`, `/api/v3/TalkService.do`
- Square = protocol **4** (compact) บน `/SQ1`
- Compact message = format ของตัวเอง (ดู 3.7) บน `/CA5`, `/ECA5`

**`NestedArray`** — DSL แทน struct: `[thriftType, fieldId, value]`
```
[8, 1, reqSeq]        // I32   field 1
[11, 2, chatMid]      // STRING field 2
[12, 3, [...]]        // STRUCT field 3
[13, 18, [11, 11, m]] // MAP<string,string> field 18
[15, 1, [11, mids]]   // LIST<string> field 1
```
type code: 2=BOOL 3=BYTE 4=DOUBLE 6=I16 8=I32 10=I64 11=STRING/BINARY 12=STRUCT 13=MAP 14=SET 15=LIST

**`writeThrift(value, methodName, Protocol)`** (`write.ts`):
1. `genHeader[3|4](methodName)` — message envelope (v3 = `80 01 00 01` + len + name + `00 00 00 00`; v4 = `82 21 00` + len + name)
2. `_writeStruct` → เดิน NestedArray เขียนทีละ field ผ่าน `TBufferedTransport`
3. ต่อ header + body + `00` ปิดท้าย
> มี 3 copy ต่อ 1 send (buftra buffer → chunks → concat) — จุด optimize ถ้าอยาก แต่ audit บอกรวมแล้ว < 0.1ms

**`readThrift(bytes, Protocol)`** (`read.ts`) → `{ data, _info: {fname,...} }`
- `data` เป็น object ที่ key เป็น **field id** (ยังไม่ rename)
- I64 → `bigInt()` คืน number ถ้า ≤ MAX_SAFE_INTEGER ไม่งั้น bigint
- STRING → ลอง decode utf-8 (`fatal`) ถ้าไม่ผ่าน = binary คืน Buffer

**`rename_data(parsed, isSquare)`** (`rename/parser.ts`):
- ดู `_info.fname` → หา struct `"<fname>_result"` (หรือ `"SquareService_<fname>_result"`)
- เดิน `def[structName]` (จาก `types/thrift.ts`) map fid → name recursive
- **ผลลัพธ์นี้แหละที่ handler เอาไปใช้** (`res.data.success`, `res.data.e`)

**`isSuccessfulThriftResponse(bytes, Protocol)`** (`read.ts`) — fast path สำหรับ `ACK_ONLY`:
- อ่านแค่ field 0 (success) vs field 1 (exception) โดยไม่สร้าง object tree
- compact: เช็ค `data[0] === 0x82`, skip varint seq + method name, อ่าน field header

### 3.2 RPC engine (`base/request/mod.ts`)

หัวใจคือ `RequestClient.request(value, methodName, protocolType, parse, path, headers, timeout, signal)`:

**`getHeader(method)`** — header ที่ทุก RPC ส่ง:
```
Host, accept: application/x-thrift, user-agent: Line/<appVersion>,
x-line-application: <device>\t<appVersion>\t<systemName>\t<systemVersion>,
content-type: application/x-thrift, x-lal: ja_JP, x-lpv: 1,
x-lhm: <POST|GET>, accept-encoding: gzip,
x-line-access: <authToken>   // ถ้ามี
```
`x-line-application` (`systemType`) มาจาก `deviceDetails` — ค่านี้คือ "fingerprint" ที่ LINE เช็ค

**`parse` มี 4 โหมด:**
| ค่า | ความหมาย |
|---|---|
| `true` | อ่าน + `rename_data` เต็ม (default) |
| `false` | อ่าน raw ไม่ rename (`res.data.success = res.data[0]`) |
| `"<StructName>"` | อ่าน + rename ด้วย struct ที่ระบุ (login ใช้ เช่น `"LoginResult"`, `"RSAKey"`, `"Profile"`) |
| `"ACK_ONLY"` | เช็คแค่ success/fail ผ่าน `isSuccessfulThriftResponse`, ไม่ decode payload — ใช้กับ send hot path |

**การเลือก transport** (สำคัญมาก — จุดที่ระบบความเร็วเสียบเข้ามา):
```ts
const hotSquareRpc = path === "/SQ1" && (methodName === "sendMessage" || methodName === "fetchSquareChatEvents");
if (hotSquareRpc) headers["x-linebot-h2-role"] = methodName === "sendMessage" ? "send" : "poll";

const response =
  useLegy                              ? await legyTransport.fetch(...)      // auth เข้ารหัส
  : (parse === "ACK_ONLY" || hotSquareRpc) ? await client.fetchHot(url, init) // ← lane pool
  :                                       await client.fetch(url, init);      // globalThis.fetch
```
> `fetchHot` = จุดต่อ H2 lane (ดู §4) `fetch` = fetch ธรรมดา

**`useLegy`** (`shouldUseLegyEncryptedRequest`): true เมื่อ
`legy.encrypted !== false` **และ** มี `x-line-access` **และ** (`encrypted === true` **หรือ** (`isLegyTalkPath(path)` **และ** token เป็น JWT/primary/authKey))
`isLegyTalkPath` = `/S3 /S4 /V4 /SYNC3 /SYNC4 /P4 /P5 /NP4 /NP5 /C5 /CA5 /ECA5`

**หลัง response:**
- `x-line-next-access` header → emit `update:authtoken` (token rotation)
- error `MUST_REFRESH_V3_TOKEN` → `auth.tryRefreshToken()` แล้ว retry 1 ครั้ง
- error `NOT_AUTHORIZED_DEVICE` → `delete authToken` + emit `end` (ตัว session-manager จับไป relogin)

### 3.3 LEGY encrypted transport (`base/request/legy.ts`) — **crypto ห้าม re-derive**

ใช้กับ path auth-sensitive (`isLegyTalkPath`) เมื่อ token เป็นแบบใหม่ (JWT/primary/authKey) ยิงไป **`https://gf.line.naver.jp/enc`** (ไม่ใช่ legy.line-apps.com)

**Constants ที่ capture มาแล้ว (เดาไม่ได้):**
```
LEGY_LE = "7"                     // header x-le  (bit1=HMAC, bit2=prefix byte)
LEGY_LAP = "5"                    // header x-lap
LEGY_LCS_PREFIX = "0008"          // prefix ของ x-lcs
LEGY_IV = [78,9,72,62,56,245,255,114,128,18,123,158,251,92,45,51]   // AES-128-CBC IV คงที่
LINE_PUBLIC_KEY = <RSA 2048 PEM ในไฟล์>   // ใช้ RSA-OAEP(sha1) encrypt AES key → x-lcs
```

**flow ขา request:**
1. `#aesKey = randomBytes(16)` (ต่อ transport instance)
2. inner headers = `{ "x-lpqs": <path+search>, "x-lt": resolveLineAccessToken(access) }` → `encodeLegyHeaders()` (u16be count, ต่อด้วย u16be(keyLen)+key+u16be(valLen)+val ต่อ entry, ทั้งก้อน prefix ด้วย u16be(bodyLen))
3. plaintext = `encodeLegyHeaders(inner) ++ body`
4. `LE & 4` → prepend byte `LE`
5. AES-128-CBC encrypt (PKCS7 auto pad) ด้วย `#aesKey` + `LEGY_IV`
6. `LE & 2` → append `legyHmac(#aesKey, encrypted)` (HMAC สร้างจาก **xxhash32** ไม่ใช่ sha — ipad `0x36` opad `0x5c` ดูโค้ด)
7. outer headers: `x-le, x-lap, x-lpv, x-lcs (RSA-OAEP ของ aesKey), user-agent, x-lal, x-lhm, ...`

**flow ขา response:**
1. AES-128-CBC decrypt (setAutoPadding **false**, pkcs7 pad เองก่อน แล้ว unpad หลัง, ตัด 16 byte ท้าย)
2. `LE & 4` → ตัด byte แรก
3. `decodeLegyHeaders(decrypted)` → `{ headers, data }` (data = thrift body จริง)
   - **ต้อง bounds-check ทุก length** (ดู §7 — เคยเป็น bug จริง)
4. `x-lc` header ≠ "200" → ใช้เป็น HTTP status

### 3.4 Auth token model (`base/request/auth_token.ts`)

LINE มี token 3 แบบ ต้องแยกให้ออกเพราะกำหนดว่าใช้ LEGY encrypted ไหม:
| แบบ | รูป | ตรวจด้วย |
|---|---|---|
| JWT | `xxx.yyy.zzz` (3 ส่วน, decode ได้, มี claim `ver/scp/exp/...`) | `isJwt()` |
| primary access token | `<mid>:<base64 ที่ decode แล้วขึ้นต้น "iat:">.` | `isPrimaryAccessToken()` |
| authKey | `<mid>:<base64>` โดย mid = `^[a-z][0-9a-f]{32}$` | `looksLikeAuthKey()` |
| legacy opaque | อื่น ๆ | (ไม่เข้า LEGY encrypted) |

- `createPrimaryAccessToken(authKey)` = HMAC-SHA1 ของ `"iat: <floor(now/1000)*60>\n"` (base64) ด้วย key ที่ decode จาก authKey → `<mid>:<iat_b64>.<digest_b64>`  ← **สร้างใหม่ทุกครั้งที่ใช้** (มี timestamp ข้างใน)
- `resolveLineAccessToken(token)` — ใช้ตอนใส่ `x-lt` ใน LEGY

### 3.5 Login — เก็บแค่ **QR v2 ForSecure** (`base/login/mod.ts` `requestSQR2`)

LINE 26+ บังคับ flow นี้ (`createQrCode` v1 เดิม server mark expired ทันที) ลำดับ:

1. `createSession()` → `POST /acct/lgn/sq/v1` method `createSession` (proto 4) → `sqr` (session id)
2. `createQrCodeForSecure(sqr)` → response `[1:callbackUrl, 2:longPollingMaxCount, 3:longPollingIntervalSec, 4:nonce]`
3. `e2ee.createSqrSecret()` → `[secret, secretUrl]` เอา `secretUrl` ต่อท้าย callbackUrl → **emit `qrcall` (ตัว UI เอาไปทำ QR)**
4. `checkQrCodeVerified(sqr, maxCount, intervalSec)` — **long-poll**: ยิง `POST /acct/lp/lgn/sq/v1` method `checkQrCodeVerified` header `x-lst: <holdMs>` + `x-line-access: <sqr>`, timeout = `holdMs + 5000` วนจนกว่า deadline (`intervalMs * maxCount`)
   - **นับเวลา wall-clock ไม่นับจำนวนครั้ง** — poll ที่ connection ตายไม่ถือว่าใช้โควตา (ดู §7)
5. (ถ้า verifyCertificate fail) `createPinCode(sqr)` → emit `pincall` → `checkPinCodeVerified(...)`
6. `qrCodeLoginV2ForSecure(sqr, nonce, modelName, systemName)` — **`modelName`/`systemName` ต้องส่งค่า device จริง** ไม่ใช่ default ของ library (เคยรั่วชื่อ library ดู §7) response `[1:pem cert, 3:tokenV3IssueResult, 4:mid, 6:metaData]`
   - `tokenInfo[1]` = accessToken, `[2]` = refreshToken, `[3]+[6]` = expire
7. E2EE: `e2eeInfo = response[10] ?? metaData["e2eeInfo"]` → `decodeE2EEKeyV1(e2eeInfo, secret)` ไม่งั้น `registerE2EEKeyPair()`
8. เก็บ `refreshToken`, `expire` ลง storage, คืน accessToken

**login ด้วย token ที่เก็บไว้** (resume): `login({ authToken })` → `parseAuthTokenInput()` → set `authToken` + เก็บ refreshToken → `ready()` = `talk.getProfile()` (ยืนยัน token ยัง valid)

`withTransportRetry()` / `pollUntilVerified()` ครอบ retry เมื่อ GOAWAY/socket ตาย (`isTransientTransportFailure`) — **จำเป็น** ไม่งั้น GOAWAY ครั้งเดียว = login พัง

### 3.6 Square RPCs (`base/service/square/mod.ts`) — เก็บ ~6 ตัว

ทุกตัว proto **4**, path **`/SQ1`**

**`sendMessage({ squareChatMid, text, fastAck })`** — hot path:
```ts
const reqSeq = client.takeReqseq("sq") ?? await client.getReqseq("sq");
request(buildSquareSendMessageArgs(reqSeq, options), "sendMessage", 4,
        options.fastAck ? "ACK_ONLY" : true, "/SQ1", {});
```
`buildSquareSendMessageArgs` = สร้าง NestedArray มือ (ไม่ผ่าน `LINEStruct` generated เพื่อไม่ scan field ที่ไม่ใช้):
```
[[12,1,[
  [8,1,reqSeq],
  [11,2,squareChatMid],
  [12,3,[
    [12,1,[ [11,2,squareChatMid], [11,10,text],
            [8,15,ContentType(0)], [13,18,[11,11,{}]] ]],   // message
    [10,4,4]                                                 // squareMessageRevision
  ]]
]]]
```
> reply แบบ thread เพิ่ม field 21 (relatedMessageId), 22 (`REPLY`), 24 (`SQUARE`)

**`fetchSquareChatEvents({ squareChatMid, syncToken, limit, direction, timeoutMs, signal })`** — poll ต่อห้อง (`timeoutMs`/`signal` ไม่ serialize ลง RPC)
**`fetchMyEvents({ syncToken, subscriptionId, continuationToken, limit })`** — poll ระดับ account (push re-arm ใช้ตัวนี้)
**`getJoinedSquares`, `getSquareChat`, `getSquareChatMembers`** — setup / ห้องที่ join
**`destroyMessage` / `unsendMessage`** — เฉพาะถ้าใช้ guardrail ลบข้อความตัวเอง

### 3.7 Compact message `/CA5` `/ECA5` (`base/service/talk/compact.ts` + `talk/mod.ts`)

Talk reply ที่เร็วสุด — binary format ของตัวเอง ไม่ใช่ Thrift:

**`packCompactPlainMessage(seqId, to, text)`** → `/CA5`:
```
byte  msgType (2 = plain)
byte  midType (u=0 r=1 c=2)
varint(zigzag)  seqId
16 byte  mid (hex ของ to.slice(1))
varint(len) + bytes  text   // BOM utf-8 หรือ utf-16LE อันที่สั้นกว่า
byte  plainSuffix (0)
```
**`packCompactE2EEMessage(seqId, to, chunks[5])`** → `/ECA5`:
```
... header เหมือนบน (msgType 5 หรือ 6) ...
byte 2
compactBinary(chunk[0..2])          // 3 ก้อนแรก len-prefixed
varint(zigzag i32)(readSignedI32(chunk[3]))   // senderKeyId
varint(zigzag i32)(readSignedI32(chunk[4]))   // receiverKeyId
```

**`decodeCompactMessageResponse(bytes)`** → `{ sequenceId, messageId: bigint, createdTime }`:
```
bool success (1=true 2=false; false → readI32 = error code, throw)
i32  sequenceId
i64  messageId
i64  createdTimeMs   // /1000
```

**`#requestCompactMessage(path, seqId, body, isRetry, fastAck)`**:
- header = `getHeader("POST")` + `x-lai: <seqId>` + **`x-linebot-h2-role: "send"`** (ไม่งั้น lane pool ไม่ทำ SEND scoring)
- ยิงผ่าน **`client.fetchHot`**
- `fastAck && parsedBody[0] === 1` → คืน `{ sequenceId: seqId, messageId: 0n, createdTime: 0 }` โดยไม่ decode
- error code 119 (+ มี refreshToken) → `auth.tryRefreshToken()` + retry

**E2EE target cache** (`#e2eeTargets` / `#checkedE2eeTargets` + storage key `compactE2EETarget:<mid>`):
- ครั้งแรกที่ยิงไป target ที่ไม่รู้จัก → `#sendCompactMessageCold` เช็ค storage ก่อน
- code 82/99 กลับมา = target นี้ต้อง E2EE → จำไว้ (ทั้ง RAM + storage) ครั้งหน้าไป `/ECA5` เลย

### 3.8 Push connection — LEGY H2 PUSH (`base/push/connManager.ts` + `conn.ts`)

**`conn.ts`** — ต่อ `node:http2` (ไม่ใช่ fetch — Bun fetch ไม่ทำ full-duplex บน long-lived POST):
```
connect(`https://legy.line-apps.com`) → session.request({
  :method POST, :path `/PUSH/1/subs?m=<bitmask>`, ... }, { endStream: false })
```
`m` = bitmask ของ service (`gen_m([1,3,5,6,8,9,10])` → `i |= 1 << (s-1)`)

parse ใน callback `request.on("data")` โดยตรง (ไม่ผ่าน Web stream — ตัด scheduler hop)

**frame format** (`readPacketHeader`): `[u16 dl][u8 dt][payload...]` — ต่อ cache ถ้า `dl > payload.length`

| `dt` | ชนิด | จัดการ |
|---|---|---|
| 1 | **ping** — `[pingType][u16 pingId]` | ถ้า `ACK_REQUIRED` → `writeByte(ackPacket())` + `onPingCallback(pingId)` |
| 3 | **sign-on-response** — `[u16 req][payload]`, `requestId = req & 0x7fff`, `isFin = req & 0x8000` | สะสม non-fin ใน `notFinPayloads[requestId]` จนกว่า fin → `onSignOnResponse()` |
| 4 | **push** — `[pushType][serviceType][u32 pushId][payload]` | ACK ถ้าต้อง → `onPushResponse()` |

**`ConnManager`:**
- **`initializeConn(state, initServices)`** — สร้าง `Conn`, ยิง `/PUSH/1/subs?m=...` (header `content-type: application/octet-stream`)
- **`buildAndSendSignOnRequest(conn, serviceType, kwargs)`** — สร้าง frame `[u16 id][serviceType][0][u16 reqLen][req]`
  - serviceType **3** = `fetchMyEvents` (compact) — Square
  - serviceType **5/8** = `sync` (compact) — Talk
  - **`#nextSignOnRequestId = (id % 0x7fff) + 1`** — id เป็น 15-bit (ดู §7)
- **`InitAndRead(initServices)`** — ส่ง status frame `[0, FLAG, pingInterval]` แล้ว arm service 3 (+ 5/8) แล้ว `conn.read()` (block จน stream ตาย)
- **`_OnSignOnResponse(reqId, isFin, data)`**:
  - service 3: `rename_data(readThrift(data, TCompactProtocol), true)` → เอา `events` push เข้า `sqStream`, อัปเดต `poll.sync.square = syncToken`, แล้ว **`#rearmSquareFetch()`** (arm ตัวถัดไป — self-perpetuating chain)
  - service 5/8: parse ด้วย `TMoreCompactProtocol` ก่อน (fallback `readThrift`) → push `opStream`, อัปเดต 3 revision (`revision`/`globalRev`/`individualRev`), arm sync ตัวถัดไป
  - **ทุกอย่างที่อ่าน/เขียน `poll.sync.square` ต้องอยู่ใน `#squareFetchQueue.run()`** (ดู §7)
- **`_OnPushResponse(frame)`** — frame service 3 มีแค่ `subscriptionId` → ต้องยิง `fetchMyEvents` แยกอีก 1 รอบเพื่อเอาเนื้อความ (คนละ round trip)
- **`_OnPingCallback(pingId)`** — ทุก `pingId % 3 === 0` → `talk.noop()` (keepalive + เช็ค `NOT_AUTHORIZED_DEVICE`)
  - **`.catch()` ต้องมี** — เคยเป็น floating promise ที่ทำ process ล่มทั้งตัว (ดู §7)
- **`rearmSquareNow()`** — repair ภายนอกเรียกเมื่อ chain หยุด (ดู staleness watchdog)
- `lastSquareFetchAt` — timestamp ที่ session-manager poll เพื่อจับ "chain ตายเงียบ"

### 3.9 Polling loop + lifecycle (`base/polling/mod.ts`)

**`initLegyPusher()`** — loop `while (client.authToken && !this.stopped)`:
```
initializeConn(1, [3,8]) → cb() → InitAndRead([3,8])   // block จน conn ตาย
catch → log LegyPusherError, backoff = min(4000, 250 * 2^min(fails,4))
finally → ปิด + splice conns[0] ที่ตายทิ้ง
```
**`stop()`** — **สำคัญมาก**: set `stopped = true` + `conns[0].close()`
> ถ้าไม่มี: loop ไม่มีทางออก (ไม่มีที่ไหน clear `authToken`) → ทุก `stopBot()`/reconnect ทิ้ง pusher ที่ยังวิ่ง → re-sign-on ด้วย credential ตาย → `NOT_AUTHORIZED_DEVICE` → logout วน (ดู §7 + memory `recurring-line-logout`)

**`listenSquareEvents()`** / **`listenTalkEvents()`** → `push.sqStream.renew()` + `initLegyPusher()` + คืน `ReadableStream`

**`client.listen({ talk, square, signal })`** (`client/client.ts`):
- `signal.abort` → `polling.stop()` + ปิด `opStream`/`sqStream`
- loop `for await (event of polling.listenSquareEvents())` → `emit("square:event")` → ถ้า `type === "NOTIFICATION_MESSAGE"` → `new SquareMessage({ raw: event.payload.notificationMessage.squareMessage })` → `emit("square:message")`
- **stamp `Symbol.for("linebot.internalReceivedAt") = performance.now()`** ตรงนี้ (จุดเริ่มนาฬิกาฝั่งรับ — audit ชี้ว่าควรขยับให้เร็วขึ้น)
- ต้อง `.catch()` loop ที่ detach ไว้ ไม่งั้น unhandled rejection = process ตาย

### 3.10 E2EE (`base/e2ee/mod.ts`) — เก็บเฉพาะถ้าต้อง Talk E2EE

**Square ไม่มี E2EE** — ถ้าบอททำแต่ Square ตัดทั้งไฟล์ได้ (แต่ login ยังเรียก `createSqrSecret` / `registerE2EEKeyPair` / `decodeE2EEKeyV1` — stub ให้ผ่านได้)

ถ้าต้อง Talk E2EE เก็บ:
| method | หน้าที่ |
|---|---|
| `createSqrSecret()` | X25519 keypair ชั่วคราวสำหรับ QR |
| `decodeE2EEKeyV1(info, secret)` / `registerE2EEKeyPair()` | ตั้ง/กู้ key ตอน login |
| `generateSharedSecret(priv, pub)` | X25519 ECDH (`curve25519-js`) |
| `getE2EELocalPublicKey(mid, keyId)` | หา/เจรจา public key ปลายทาง (+ group key) |
| `negotiateE2EEPublicKey(...)` (บน `talk`) | ขอ public key จาก server |
| `encryptE2EEMessage(to, text, contentType)` | → 5 chunks (salt, nonce, ciphertext, senderKeyId, receiverKeyId) |
| `decryptE2EEMessage(messageObj)` | ถอด incoming (`event.message.chunks`) |
| `encryptE2EEMessageV2` / `decryptE2EEMessageV2` | AES-256-GCM + AAD (`@noble/ciphers`) |
| `encryptDeviceSecret` / `decryptKeyChain` | e2ee login handshake |

### 3.11 Storage (`base/storage/base.ts`)

interface อย่างเดียว — impl เป็นของโปรเจค:
```ts
abstract class BaseStorage {
  set(key, value): Promise<void>
  get(key): Promise<Value | undefined>
  delete(key): Promise<void>
  clear(): Promise<void>
  migrate(other): Promise<void>
}
```
key ที่ระบบใช้จริง: `reqseq`, `refreshToken`, `expire`, `qrCert`, `cert:<email>`, `compactE2EETarget:<mid>`, E2EE key data
> โปรเจคนี้ impl เป็น **RAM Map + write-behind** — `getReqseq()` เป็น hot path (`takeReqseq()` sync, persist ผ่าน `queueMicrotask`) อย่าให้ `set()` เป็น await บน hot path

### 3.12 Device emulation (`base/core/utils/devices.ts`)

```ts
getDeviceDetails("DESKTOPWIN", version?) → {
  device: "DESKTOPWIN", appVersion: "9.7.0.3556", systemName: "WINDOWS", systemVersion: "10.0.0-NT-x64"
}
```
- `appVersion` = ตัวที่ต้อง **bump เองเป็นระยะ** เมื่อ LINE บังคับเวอร์ชันใหม่
- `isV3Support(device)` → DESKTOPWIN/MAC/IOS/ANDROID/ANDROIDSECONDARY ใช้ v3 login
- `defaultModelName(device)` → ค่าที่ส่งใน `qrCodeLoginV2ForSecure` (ต้อง "ดูเหมือนจริง" ไม่ใช่ชื่อ library)

---

## 4. จุดต่อกับระบบความเร็ว (`dispatch/`) — **ไม่ต้องเขียนใหม่**

linejs-core เปิด extension point เดียว: `ClientInit.fetch` (`FetchLike`)

**`base/core/mod.ts`** ตอน construct:
```ts
if (init.fetch) {
  this.#customFetch      = init.fetch;
  this.#hotFetch         = getHotLineFetch(init.fetch);        // จาก dispatch/direct-request.ts
  this.#hotPrewarmFetch  = getHotLinePrewarmFetch(init.fetch);
}
// fetch     → #customFetch ?? globalThis.fetch      (RPC ทั่วไป, login, push)
// fetchHot  → #hotFetch ?? fetch                    (sendMessage, fetchSquareChatEvents, /CA5, /ECA5)
```

**ฝั่งโปรเจค** (`dispatch/client.ts` `createDispatchFetch(config, botRouteKey)`) ประกอบ `FetchLike` ที่:
- push stream (`/PUSH/1/subs`) → `globalThis.fetch` เสมอ
- compact Talk (`/CA5`,`/ECA5`) → `fetchLineDirect` (H2 lane) + header `x-linebot-h2-route-key: <bot>:t`
- Square send/poll → ผ่าน `attachHotLineFetch` → `fetchLineDirect` → **`laneFetch()`** ใน `h2-lanes.ts`
- อื่น ๆ → Go relay (loopback) — rollback path

**header ที่ linejs-core ต้องแปะให้ lane pool ทำงาน** (มีอยู่แล้วในโค้ด อย่าลบ):
| header | ค่า | ตั้งที่ไหน |
|---|---|---|
| `x-linebot-h2-role` | `send` / `poll` | `request/mod.ts` (`hotSquareRpc`), `talk/mod.ts` `#requestCompactMessage` |
| `x-linebot-h2-route-key` | `<botId>` หรือ `<botId>:t` | `dispatch/client.ts` `routeHeaders()` |

> `h2-lanes.ts` / `send-prediction.ts` = **โค้ดโปรเจค ไม่ใช่ linejs** — เขียน client ใหม่ก็ใช้ของเดิมได้เลย แค่ยิง header 2 ตัวนี้ให้ถูก

---

## 5. ตัดทิ้งได้ทันที (ไม่อยู่บน path ของบอท)

**service ทั้งโฟลเดอร์** (`base/service/`): `accesstokenrefresh`* `accountauthfactoreapconnect` `botexternal` `call` `channel` `chatapp` `coin` `deviceattestation`* `e2eekeybackup`* `homesafetycheck` `liff` `livetalk` `multiprofile` `oachat` `oamembership` `passwordupdate` `premiumfont` `premiumstatus` `primaryaccount*` (ทุกตัว) `primaryqrcode*` `primaryseamlesslogin` `pwlessprimaryregistration` `secondary*login` `settings` `shop` `shopauth` `shopcollection` `squarebot` `relation`(เก็บถ้าต้อง friend/OA) `buddy`

> \* = login/token บางเส้นอาจแตะ — เช็คก่อนลบ

**feature / อื่น ๆ:** `base/timeline/` `base/obs/` (upload รูป) `client/features/{voom,liff,profile,voice}` `client/features/message/utils.ts` (sticker ฯลฯ) `base/service/talk/e2ee-target-cache.test.ts` (เก็บ logic ทิ้ง test) `timeline`

**login เส้นที่ไม่ใช้:** `requestEmailLogin`, `requestEmailLoginV2`, `requestSQR` (v1), `qrCodeLogin`/`qrCodeLoginV2` (non-ForSecure), `loginV2`, `getRSAKeyInfo`, `confirmE2EELogin`, `respondE2EELoginRequest`

**ประเมิน:** จาก ~84,000 บรรทัด เหลือ core จริง ~6,000–8,000 บรรทัด (ไม่นับ 3 ไฟล์ generated 67k ที่เก็บทั้งดุ้น)

---

## 6. ลำดับการเขียน (build order)

1. **Thrift codec** — port `declares.ts` + `write.ts` + `read.ts` + `rename/parser.ts` ตามเดิม (พึ่ง `thrift` + `node-int64`) → unit test: encode/decode round-trip ของ `buildSquareSendMessageArgs`
2. **Storage interface** + impl RAM (+ persist ทีหลัง)
3. **RequestClient** (`request/mod.ts`) — `getHeader`, `request()`, 4 โหมด parse, error/refresh — ยังไม่ต้องมี LEGY, ยิง `globalThis.fetch` ตรง ๆ ก่อน
4. **Device details** + **auth_token** (แยกชนิด token)
5. **Login QR v2 ForSecure** — createSession → createQrCodeForSecure → checkQrCodeVerified (long-poll) → qrCodeLoginV2ForSecure → เก็บ token
   - milestone: login สำเร็จ, `getProfile()` คืนชื่อบอท
6. **LEGY encrypted transport** (`legy.ts`) — port ทั้งไฟล์ (constants + AES + RSA + xxhash HMAC + encode/decodeLegyHeaders พร้อม bounds-check) → เปิด `shouldUseLegyEncryptedRequest`
   - milestone: token JWT resume ได้ (path `/S4` `getProfile` ผ่าน LEGY)
7. **Square service** — `sendMessage` + `fetchSquareChatEvents` + `fetchMyEvents` + `getJoinedSquares`/`getSquareChat`
   - milestone: ยิง `sendMessage` เข้าห้องทดสอบส่วนตัวได้ (ยังไม่ต้อง lane pool — ใช้ fetch ตรง)
8. **Push** — `conn.ts` (node:http2 framing) → `connManager.ts` (sign-on service 3, `_OnSignOnResponse`, `#rearmSquareFetch`, `#squareFetchQueue`, ping/noop keepalive) → `polling.ts` (`initLegyPusher` + **`stop()`**)
   - milestone: `listen({ square: true })` ได้ event ห้องทดสอบ real-time
9. **client/client.ts** + `SquareMessage` wrapper + event emitter → ต่อกับ handler เดิมของบอท
10. **Compact message** (`compact.ts` + `talk/mod.ts` เฉพาะ compact + `sync` + `noop`) → Talk reply
11. **E2EE** — เฉพาะถ้าต้อง Talk 1:1/group ที่เข้ารหัส (ไม่งั้น stub)
12. **เสียบ `dispatch/` เดิม** — ส่ง `createDispatchFetch(...)` เป็น `ClientInit.fetch`, ยืนยัน header `x-linebot-h2-role` / `x-linebot-h2-route-key` ออกถูก

---

## 7. กับดักที่พลาดแล้วพัง (bug history — ฝังใน fork แล้ว อย่าเขียนพลาดซ้ำ)

1. **I64 encoding** (`write.ts:129`) — `node-int64` parse string เปล่าเป็น **hex** → ต้องส่ง `new Int64("0x" + BigInt.asUintN(64, val).toString(16).padStart(16,"0"))` ไม่งั้น message id เพี้ยน → `MESSAGE_NOT_FOUND`
2. **`decodeLegyHeaders` bounds-check** (`legy.ts:159`) — response ที่ถูก truncate (lane ปิดกลางคัน) ต้อง throw `LegyProtocolError` ที่บอกว่าอ่าน field ไหนขาดกี่ byte ไม่ใช่ปล่อยให้ `Buffer.readUInt16BE` โยน `RangeError: offset out of range` ดิบ ๆ (+ cap `MAX_LEGY_HEADER_COUNT = 4096`)
3. **pusher loop `stop()`** (`polling.ts:61`) — loop เงื่อนไข `while (client.authToken)` ไม่มีที่ไหน clear `authToken` → **ต้องมี flag `stopped` + `stop()` ที่ปิด `conns[0]`** ไม่งั้น zombie pusher re-sign-on → `NOT_AUTHORIZED_DEVICE` วน (memory: `recurring-line-logout`) เช็คสุขภาพ: `ss -tnp | grep ESTAB | grep -c bun` ควรเป็นหลักหน่วยต่อบอท
4. **sign-on reqId 15-bit** (`connManager.ts:65`) — `req & 0x8000` สงวนให้ `isFin` → id ต้อง `(x % 0x7fff) + 1` **และ** ต้อง `delete this.signOnRequests[reqId]` เมื่อได้ fin (ไม่งั้น wrap แล้ว alias entry เก่า serviceType ผิด)
5. **`#squareFetchQueue` race** (`connManager.ts:90`) — push notification กับ re-arm long-poll อ่าน `poll.sync.square` พร้อมกัน → ตัวที่เขียนทีหลังชนะ → advance token ข้ามช่วงที่อีกตัวถืออยู่ → **event หายเงียบ** ทุกจุดที่แตะ `poll.sync.square` ต้องอยู่ใน `#squareFetchQueue.run()`
6. **`#rearmSquareFetch` อ่าน conn หลัง delay** (`connManager.ts:572`) — capture `conns[0]` ก่อน `await delay` แล้ว conn reconnect ระหว่างนั้น → write ลง conn ที่ splice ไปแล้ว → throw → chain ตายเงียบ OpenChat เงียบทั้ง ๆ ที่ session ดูปกติ
7. **`noop()` keepalive ต้อง `.catch()`** (`connManager.ts:686`) — floating promise ที่ reject ด้วย `NOT_AUTHORIZED_DEVICE` เคยทำ **backend ล่มทั้ง process** (ทุกบอท) — จับเป็น push failure ให้ watchdog reconnect แทน
8. **detached listener loop ต้อง `.catch()`** (`client.ts:144,177`) — `for await` loop ที่ detach ถ้า reject = process ตาย ไม่ใช่แค่ stream นั้น รายงานเป็น `ListenerStopped` (health check แบบ auth-only มองไม่เห็น listener ตาย)
9. **`sync_result` / `fetchMyEvents_result` เป็น thrift union** — ต้องเช็ค `res.e` ก่อนอ่าน `res.success.xxx` ไม่งั้น `TalkException` ทำ `.fullSyncResponse` crash แล้ว sync chain ตายเงียบ (`connManager.ts:431`)
10. **QR login `modelName`/`systemName`** (`login.ts:301`) — default ของ library คือ `"evex-device"`/`"linejs-v2"` = ประกาศตัวเป็น unofficial client ตรง ๆ → ส่ง `defaultModelName(device)` + `deviceDetails.systemName` แทน
11. **long-poll นับ wall-clock ไม่นับครั้ง** (`login.ts:628`) — poll ที่ connection ตาย = ไม่ได้ถามคำถาม → re-issue โดยไม่หักโควตา `maxCount` ไม่งั้น GOAWAY ครั้งเดียวจบ login ที่ user กำลังสแกน
12. **`reqseq` persist ห้าม await บน hot path** (`core/mod.ts:273`) — `takeReqseq()` sync คืนเลย, persist ผ่าน `queueMicrotask` coalesced — await เพิ่ม ~1.1ms ต่อ send
13. **`ACK_ONLY` ไม่ใช่ transport early-return** — `sendOnLane` buffer ทุก DATA chunk + resolve ตอน stream `close` อยู่ดี — `ACK_ONLY` ประหยัดแค่ Thrift decode ฝั่งเรา (~ไมโครวินาที) ไม่ได้ประหยัด round trip
14. **`rename_thrift` `#fid2name` เป็น linear `findIndex`** (`parser.ts:11`) — ต่อ field ต่อ struct node ไม่มี memo, struct ใหญ่ ~60 entry — audit ชี้เป็นจุด optimize (ทำเป็น `Map<fid,name>` ต่อ struct) ที่อยู่บน critical path ฝั่งรับ

---

## 8. สิ่งที่ audit (2026-08-27) ยืนยันว่า "สุดแล้ว" — ไม่ต้องเสียเวลาปรับตอนเขียนใหม่

- send path จาก "ตัดสินใจ reply" → `stream.end(body)` ไม่มี microtask tick เกิน, ไม่แตะ disk, ไม่มี hop ซ้ำ
- reqSeq = RAM Map + write-behind แล้ว
- Square `sendMessage` เข้า `fetchHot` ไม่ว่าจะ `ACK_ONLY` หรือไม่ → ไม่เคยตกไป Go loopback relay
- compact Talk เรียก `fetchHot` ตรง
- allocation รวมทั้ง send path < 0.1ms

**ครึ่งที่ยังมีที่เหลือคือ inbound** (protocol-bound: ทุกทางรับ Square = poll ที่เรายิงเอง mean ≈ 1 round trip ~20-25ms) — ไม่ใช่เรื่องที่เขียน client ใหม่แล้วดีขึ้น เว้นแต่เปลี่ยนวิธี detect (เช่น sibling cursor หลายตัวต่อห้อง = min over N)
