<#
.SYNOPSIS
    เครื่องมือจัดการ LINE Bot บน AWS - deploy, restart, ตรวจสอบสถานะ

.DESCRIPTION
    รวมทุกคำสั่งไว้ในไฟล์เดียว เรียกใช้แบบเมนู หรือระบุ -Action ตรงๆ ก็ได้

.EXAMPLE
    .\Manage-LineBot.ps1
    เปิดเมนูให้เลือก

.EXAMPLE
    .\Manage-LineBot.ps1 -Action check
    ตรวจสอบสถานะอย่างเดียว (ปลอดภัย ไม่แตะอะไร)

.EXAMPLE
    .\Manage-LineBot.ps1 -Action deploy -DryRun
    ลอง deploy ดูว่าจะทำอะไรบ้าง โดยไม่แตะเซิร์ฟเวอร์จริง

.NOTES
    หมายเหตุสำคัญเรื่องสถาปัตยกรรม:
    - Go (sender) ไม่ใช่ service แยก แต่เป็นลูกของ Bun - Bun เป็นคน spawn ขึ้นมา
      ดังนั้นการรีสตาร์ต Go ต้องรีสตาร์ต service ของ Bun เสมอ ไม่มีทางรีแยกได้
    - Node.js ไม่ได้ติดตั้งบนเครื่องนี้ และโปรเจกต์นี้ไม่ได้ใช้ Node (ใช้ Bun แทน)
#>

[CmdletBinding()]
param(
    [ValidateSet('menu', 'deploy', 'restart-go', 'restart-bun', 'restart-nginx', 'check', 'reboot')]
    [string]$Action = 'menu',

    # แสดงว่าจะทำอะไรบ้าง โดยไม่แตะเซิร์ฟเวอร์จริง (ใช้ได้กับ deploy)
    [switch]$DryRun,

    # ข้ามคำถามยืนยัน - สำหรับรันอัตโนมัติ ใช้อย่างระวัง
    [switch]$Force,

    [string]$SshHost = 'admin@3.112.61.130',
    [string]$SshKey = (Join-Path $PSScriptRoot 'maxpc.pem'),
    [string]$RemoteApp = '/home/admin/bunandgo',
    [string]$WebRoot = '/var/www/linebot',
    [string]$BotService = 'linebot-backend',
    [string]$NginxService = 'nginx',
    [string]$SiteUrl = 'https://dakotabot.site'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:BunPath = '/home/admin/.bun/bin/bun'
$script:LastRemoteExit = 0

#region ---------- helpers ----------

function Write-Head {
    param([string]$Text)
    Write-Host ''
    Write-Host "==> $Text" -ForegroundColor Cyan
}

function Write-Ok { param([string]$Text) Write-Host "  [OK]   $Text" -ForegroundColor Green }
function Write-Warn { param([string]$Text) Write-Host "  [WARN] $Text" -ForegroundColor Yellow }
function Write-Bad { param([string]$Text) Write-Host "  [FAIL] $Text" -ForegroundColor Red }
function Write-Info { param([string]$Text) Write-Host "  $Text" -ForegroundColor Gray }

<#
    ตรวจของที่ต้องมีก่อนเริ่ม พร้อมแก้สิทธิ์ไฟล์ key ให้อัตโนมัติ

    OpenSSH บน Windows จะปฏิเสธ private key ที่บัญชีอื่นอ่านได้ ("UNPROTECTED
    PRIVATE KEY FILE") ซึ่งเป็นค่าเริ่มต้นของไฟล์ที่ก๊อปมาวางเฉยๆ และ chmod
    จาก Git Bash ก็แก้ไม่ได้ เพราะ Windows ดูที่ ACL ไม่ใช่โหมดแบบ POSIX
    การแก้ตรงนี้คือ "ลดสิทธิ์" ให้เหลือเฉพาะเจ้าของ จึงปลอดภัยขึ้น ไม่ใช่ลดลง
#>
function Assert-Prerequisites {
    if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
        throw 'ไม่พบคำสั่ง ssh - ติดตั้ง OpenSSH Client บน Windows ก่อน'
    }
    if (-not (Test-Path -LiteralPath $SshKey -PathType Leaf)) {
        throw "ไม่พบ SSH key: $SshKey"
    }

    $acl = (icacls $SshKey 2>$null | Out-String)
    if ($acl -match 'Authenticated Users|BUILTIN\\Users|Everyone') {
        Write-Warn 'สิทธิ์ไฟล์ SSH key เปิดกว้างเกินไป - OpenSSH จะไม่ยอมใช้'
        Write-Info 'กำลังจำกัดให้เหลือเฉพาะบัญชีคุณ...'
        $null = icacls $SshKey /inheritance:r /grant:r "$($env:USERNAME):(R)" 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "แก้สิทธิ์ไฟล์ไม่สำเร็จ ลองรันเอง: icacls `"$SshKey`" /inheritance:r /grant:r `"$($env:USERNAME):(R)`""
        }
        Write-Ok 'แก้สิทธิ์เรียบร้อย'
    }
}

<#
    ห่อสคริปต์ bash ให้ส่งข้ามไปเป็น base64

    ส่งผ่าน stdin ตรงๆ ไม่ได้: PowerShell แปลง LF เป็น CRLF ตอนเขียนเข้า stdin
    ของโปรแกรมภายนอก bash จึงได้ `exit "0\r"` แล้วฟ้อง "numeric argument
    required" ทั้งที่ค่าถูกต้อง (และ `head -2` กลายเป็น `head -2\r`)
    base64 เป็น ASCII บรรทัดเดียว จึงรอดทั้งการแปลงบรรทัดและการ quote ของ
    Windows พร้อมส่งภาษาไทยแบบ UTF-8 ได้ครบโดยไม่เพี้ยน
#>
function Get-RemoteCommand {
    param([Parameter(Mandatory)][string]$Script)
    $unix = $Script -replace "`r`n", "`n"
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($unix))
    return "echo $b64 | base64 -d | bash -s"
}

<#
    รันสคริปต์ bash บนเซิร์ฟเวอร์ แล้วพิมพ์ผลลัพธ์ออกหน้าจอ

    เขียนผลลัพธ์ด้วย Write-Host ไม่ใช่ปล่อยลง pipeline เพราะ stdout ของ ssh
    จะไหลไปรวมกับค่าที่ฟังก์ชัน return แล้วถูกกลืนโดยผู้เรียกอย่าง
    `exit (Invoke-Check)` - อาการคือรายงานสถานะไม่แสดงอะไรเลยสักบรรทัด
    exit code เก็บไว้ที่ $script:LastRemoteExit แทนการ return
#>
function Invoke-Remote {
    param(
        [Parameter(Mandatory)][string]$Script,
        [switch]$AllowFailure
    )
    $output = & ssh -i $SshKey -o ConnectTimeout=15 -o BatchMode=yes $SshHost (Get-RemoteCommand $Script) 2>&1
    $script:LastRemoteExit = $LASTEXITCODE
    foreach ($line in @($output)) { Write-Host $line }
    if ($script:LastRemoteExit -ne 0 -and -not $AllowFailure) {
        throw "คำสั่งบนเซิร์ฟเวอร์ล้มเหลว (exit $script:LastRemoteExit)"
    }
}

<# เหมือน Invoke-Remote แต่คืนข้อความกลับมาให้ประมวลผลต่อ (ไม่แสดงบนจอ) #>
function Invoke-RemoteCapture {
    param([Parameter(Mandatory)][string]$Script)
    $output = & ssh -i $SshKey -o ConnectTimeout=15 -o BatchMode=yes $SshHost (Get-RemoteCommand $Script) 2>$null
    $script:LastRemoteExit = $LASTEXITCODE
    return ($output | Out-String).Trim()
}

function Confirm-Action {
    param(
        [Parameter(Mandatory)][string]$Message,
        [string]$Expect = 'y'
    )
    if ($Force) {
        Write-Info '(-Force: ข้ามการยืนยัน)'
        return $true
    }
    $answer = Read-Host "$Message [พิมพ์ '$Expect' เพื่อยืนยัน]"
    return $answer -eq $Expect
}

#endregion

#region ---------- 5. ตรวจสอบสถานะ ----------

<#
    ตรวจทุกชั้นของ stack แบบอ่านอย่างเดียว - ไม่แตะ ไม่รีสตาร์ตอะไรทั้งสิ้น

    รวม "จำนวน connection ไป LINE" ไว้ด้วย เพราะเคยเจอเคสจริงที่ pusher loop
    รั่ว: ตัวเลขนี้ไต่ขึ้นเรื่อยๆ (เคยขึ้นถึง 25 ทั้งที่ควรมีบอทออนไลน์แค่ตัวเดียว)
    เป็นสัญญาณเตือนล่วงหน้าก่อนที่ LINE จะเตะบัญชีออก ค่าปกติคือ 3-8
#>
function Invoke-Check {
    Write-Head 'ตรวจสอบสถานะระบบทั้งหมด'

    $remote = @'
set -uo pipefail
BOT_SERVICE="__BOT__"
NGINX_SERVICE="__NGINX__"
APP="__APP__"
BUN="__BUN__"
FAIL=0

echo "------------- SERVICES -------------"
for svc in "$NGINX_SERVICE" "$BOT_SERVICE"; do
    state="$(systemctl is-active "$svc" 2>/dev/null || true)"
    if [ "$state" = "active" ]; then
        printf "  [OK]   %-22s %s\n" "$svc" "$state"
    else
        printf "  [FAIL] %-22s %s\n" "$svc" "${state:-unknown}"
        FAIL=1
    fi
done

echo
echo "------------- RUNTIMES -------------"

# Bun - โปรเซสหลัก
MAIN_PID="$(systemctl show "$BOT_SERVICE" -p MainPID --value 2>/dev/null || echo 0)"
if [ "${MAIN_PID:-0}" -gt 0 ] 2>/dev/null; then
    BUN_RSS="$(ps -o rss= -p "$MAIN_PID" 2>/dev/null | tr -d ' ')"
    BUN_ET="$(ps -o etime= -p "$MAIN_PID" 2>/dev/null | tr -d ' ')"
    printf "  [OK]   %-22s pid=%s mem=%sMB uptime=%s\n" "bun (backend)" "$MAIN_PID" "$((${BUN_RSS:-0}/1024))" "${BUN_ET:-?}"
else
    printf "  [FAIL] %-22s ไม่มีโปรเซส\n" "bun (backend)"
    FAIL=1
fi

# Go sender - เป็นลูกของ Bun ไม่ใช่ service แยก
SENDER_PID="$(pgrep -f "$APP/backend/sender/sender" | head -1 || true)"
if [ -n "${SENDER_PID:-}" ]; then
    if ss -tlnp 2>/dev/null | grep -q '127.0.0.1:4790'; then
        printf "  [OK]   %-22s pid=%s ฟังที่ 127.0.0.1:4790\n" "go (sender relay)" "$SENDER_PID"
    else
        printf "  [WARN] %-22s pid=%s แต่ไม่ได้ฟังพอร์ต 4790\n" "go (sender relay)" "$SENDER_PID"
        FAIL=1
    fi
else
    printf "  [FAIL] %-22s ไม่มีโปรเซส (ต้องรีสตาร์ต bun เพื่อ spawn ใหม่)\n" "go (sender relay)"
    FAIL=1
fi

# Node - โปรเจกต์นี้ไม่ได้ใช้ ตรวจไว้เพื่อยืนยันว่าไม่ได้หายไปเฉยๆ
if command -v node >/dev/null 2>&1; then
    printf "  [INFO] %-22s %s (มีติดตั้ง แต่ stack นี้ไม่ได้ใช้)\n" "node" "$(node -v)"
else
    printf "  [INFO] %-22s ไม่ได้ติดตั้ง - ปกติ เพราะโปรเจกต์นี้ใช้ Bun แทน\n" "node"
fi

if [ -x "$BUN" ]; then
    printf "  [OK]   %-22s %s\n" "bun (binary)" "$($BUN --version 2>/dev/null)"
fi
if [ -x /usr/local/go/bin/go ]; then
    printf "  [OK]   %-22s %s\n" "go (toolchain)" "$(/usr/local/go/bin/go version 2>/dev/null | awk '{print $3}')"
fi

echo
echo "------------- NGINX CONFIG -------------"
if sudo nginx -t >/dev/null 2>&1; then
    echo "  [OK]   config ถูกต้อง"
else
    echo "  [FAIL] config ผิด:"
    sudo nginx -t 2>&1 | sed 's/^/         /'
    FAIL=1
fi

echo
echo "------------- BOTS -------------"
if [ -f "$APP/backend/data/app.db" ]; then
    sqlite3 "$APP/backend/data/app.db" "SELECT '  ' || id || '  ' || name || '  -> ' || status FROM bots;" 2>/dev/null || echo "  (อ่านฐานข้อมูลไม่ได้)"
    FEED_IN="$(sqlite3 "$APP/backend/data/app.db" 'SELECT count(*) FROM messages_in;' 2>/dev/null || true)"
    echo "  บันทึกสด: ข้อความเข้าที่เก็บไว้ ${FEED_IN:-0} แถว"
else
    echo "  [WARN] ไม่พบไฟล์ฐานข้อมูล"
fi

echo
echo "------------- LINE CONNECTIONS -------------"
# `grep -c` พิมพ์ "0" อยู่แล้วเมื่อไม่เจอ แต่คืน exit 1 - ถ้าใช้ `|| echo 0`
# ต่อท้าย ค่าจะกลายเป็น "0\n0" แล้วไปพังที่ `exit "$FAIL"` ตอนท้าย
CONNS="$(ss -tn 2>/dev/null | grep -c '147\.92\.' || true)"
CONNS="${CONNS:-0}"
if [ "$CONNS" -le 10 ]; then
    printf "  [OK]   %s connections ไป LINE (ปกติ)\n" "$CONNS"
elif [ "$CONNS" -le 20 ]; then
    printf "  [WARN] %s connections ไป LINE - เริ่มสูงผิดปกติ เฝ้าดูว่าไต่ขึ้นเรื่อยๆ ไหม\n" "$CONNS"
else
    printf "  [FAIL] %s connections ไป LINE - สูงมาก น่าจะมี pusher loop รั่ว\n" "$CONNS"
    FAIL=1
fi

echo
echo "------------- RESOURCES -------------"
printf "  load:%s\n" "$(uptime | sed 's/.*load average://')"
free -m | awk '/^Mem:/ {printf "  memory: ใช้ %sMB / %sMB (เหลือ %sMB)\n", $3, $2, $7}'
df -h / | awk 'NR==2 {printf "  disk:   ใช้ %s / %s (%s)\n", $3, $2, $5}'

echo
echo "------------- API / SITE -------------"
API_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:8790/api/health || echo 000)"
# 401 = ตัว API ตอบอยู่ แค่ยังไม่ได้ล็อกอิน ซึ่งถือว่าปกติ
if [ "$API_CODE" = "200" ] || [ "$API_CODE" = "401" ]; then
    echo "  [OK]   backend API ตอบสนอง (HTTP $API_CODE)"
else
    echo "  [FAIL] backend API ไม่ตอบสนอง (HTTP $API_CODE)"
    FAIL=1
fi

exit "$FAIL"
'@

    $remote = $remote.Replace('__BOT__', $BotService).Replace('__NGINX__', $NginxService).Replace('__APP__', $RemoteApp).Replace('__BUN__', $script:BunPath)
    Invoke-Remote -Script $remote -AllowFailure
    $code = $script:LastRemoteExit

    Write-Head 'เว็บไซต์ภายนอก'
    try {
        $res = Invoke-WebRequest -Uri $SiteUrl -Method Head -TimeoutSec 15 -UseBasicParsing
        Write-Ok "$SiteUrl -> HTTP $($res.StatusCode)"
    }
    catch {
        Write-Bad "$SiteUrl -> เข้าไม่ได้: $($_.Exception.Message)"
        $code = 1
    }

    Write-Host ''
    if ($code -eq 0) {
        Write-Host 'สรุป: ระบบทำงานปกติทุกส่วน' -ForegroundColor Green
    }
    else {
        Write-Host 'สรุป: พบปัญหา - ดูบรรทัด [FAIL] ด้านบน' -ForegroundColor Red
    }
    return $code
}

#endregion

#region ---------- 2/3. รีสตาร์ต backend (Bun + Go) ----------

<#
    รีสตาร์ต service ของ backend

    -RebuildGo จะลบไบนารีของ sender ทิ้งก่อน เพื่อให้ Bun คอมไพล์ใหม่ตอนบูต
    (index.ts มีตรรกะ senderNeedsBuild อยู่แล้ว) นี่คือความต่างเพียงอย่างเดียว
    ระหว่างเมนู "รีสตาร์ต Go" กับ "รีสตาร์ต Bun" - เพราะ Go เป็นลูกของ Bun
    จึงรีแยกกันไม่ได้จริงๆ
#>
function Restart-Backend {
    param([switch]$RebuildGo)

    $what = if ($RebuildGo) { 'Go relay (คอมไพล์ใหม่ + รีสตาร์ต backend)' } else { 'Bun backend' }
    Write-Head "รีสตาร์ต $what"

    if ($RebuildGo) {
        Write-Warn 'Go ทำงานเป็นลูกของ Bun จึงต้องรีสตาร์ต backend ทั้งตัว'
    }
    Write-Warn 'บอทจะออฟไลน์ชั่วคราวประมาณ 10-20 วินาที'

    # เช็คก่อนว่ามีคนกำลังใช้หน้าเว็บอยู่ไหม - เคยรีสตาร์ตทับจังหวะที่ผู้ใช้
    # กำลังสแกน QR อยู่พอดี แล้วทำให้การล็อกอินนั้นล่มมาแล้ว
    Write-Info 'ตรวจกิจกรรมล่าสุดบนหน้าเว็บ...'
    $recent = "sqlite3 $RemoteApp/backend/data/app.db `"SELECT count(*) FROM user_actions WHERE ts > (strftime('%s','now')-300)*1000;`" 2>/dev/null || echo 0"
    $activity = Invoke-RemoteCapture -Script $recent
    if ($activity -match '^\d+$' -and [int]$activity -gt 0) {
        Write-Warn "มีการใช้งานหน้าเว็บ $activity ครั้งใน 5 นาทีที่ผ่านมา - อาจมีคนกำลังทำงานอยู่"
        if (-not (Confirm-Action 'ยืนยันรีสตาร์ตต่อ?')) {
            Write-Info 'ยกเลิกแล้ว'
            return 1
        }
    }

    $rebuildCmd = if ($RebuildGo) { "rm -f $RemoteApp/backend/sender/sender" } else { 'true' }
    $remote = @'
set -uo pipefail
__REBUILD__
sudo systemctl restart __BOT__
sleep 12
state="$(systemctl is-active __BOT__)"
echo "service: $state"
[ "$state" = "active" ] || exit 1
SENDER_PID="$(pgrep -f '__APP__/backend/sender/sender' | head -1 || true)"
if [ -n "${SENDER_PID:-}" ]; then
    echo "go sender: ทำงานแล้ว (pid $SENDER_PID)"
else
    echo "go sender: ไม่ขึ้น"
    exit 1
fi
sqlite3 __APP__/backend/data/app.db "SELECT '  bot ' || id || ' ' || name || ' -> ' || status FROM bots;" 2>/dev/null
'@.Replace('__REBUILD__', $rebuildCmd).Replace('__BOT__', $BotService).Replace('__APP__', $RemoteApp)

    Invoke-Remote -Script $remote -AllowFailure
    $code = $script:LastRemoteExit
    if ($code -eq 0) { Write-Ok 'รีสตาร์ตสำเร็จ' } else { Write-Bad 'รีสตาร์ตไม่สำเร็จ - ดูข้อความด้านบน' }
    return $code
}

#endregion

#region ---------- 4. รีสตาร์ต nginx ----------

function Restart-Nginx {
    Write-Head 'รีสตาร์ต Nginx'
    Write-Info 'กระทบเฉพาะหน้าเว็บ - บอทยังตอบข้อความตามปกติ'

    # ตรวจ config ก่อนเสมอ: รีสตาร์ตด้วย config ที่ผิดจะทำให้เว็บล่มยาว
    $remote = @'
set -uo pipefail
if ! sudo nginx -t 2>&1; then
    echo "[FAIL] config ผิด - ไม่รีสตาร์ต เพื่อกันเว็บล่มหนักกว่าเดิม"
    exit 1
fi
sudo systemctl restart __NGINX__
sleep 2
state="$(systemctl is-active __NGINX__)"
echo "nginx: $state"
[ "$state" = "active" ]
'@.Replace('__NGINX__', $NginxService)

    Invoke-Remote -Script $remote -AllowFailure
    $code = $script:LastRemoteExit
    if ($code -eq 0) { Write-Ok 'Nginx รีสตาร์ตสำเร็จ' } else { Write-Bad 'Nginx รีสตาร์ตไม่สำเร็จ' }
    return $code
}

#endregion

#region ---------- 1. Deploy ----------

<#
    Deploy โค้ดที่ commit แล้วขึ้น AWS

    ส่งเฉพาะสิ่งที่อยู่ใน git (git archive) แล้วคงไฟล์ที่ไม่ได้อยู่ใน git ไว้
    ได้แก่ .env และ data/ ซึ่งเป็นความลับกับฐานข้อมูลจริง - ห้ามถูกทับเด็ดขาด

    frontend build ที่เครื่องเราแล้วค่อยอัปโหลด dist ขึ้นไป เพราะเซิร์ฟเวอร์มี
    RAM แค่ 2GB การ build บนนั้นเสี่ยงกว่าและช้ากว่า
#>
function Invoke-Deploy {
    Write-Head 'Deploy ขึ้น AWS'

    Push-Location $PSScriptRoot
    try {
        $dirty = git status --porcelain 2>$null | Where-Object { $_ -notmatch 'tsbuildinfo' }
        if ($dirty) {
            Write-Warn 'มีไฟล์ที่ยังไม่ commit - deploy จะส่งเฉพาะที่ commit แล้วเท่านั้น:'
            $dirty | Select-Object -First 10 | ForEach-Object { Write-Info "    $_" }
            if (-not $DryRun -and -not (Confirm-Action 'ทำต่อไหม?')) {
                Write-Info 'ยกเลิกแล้ว'
                return 1
            }
        }

        $commit = (git log -1 --format='%h %s' 2>$null)
        Write-Info "commit ที่จะ deploy: $commit"

        if ($DryRun) {
            Write-Host ''
            Write-Host 'โหมด DryRun - จะทำสิ่งเหล่านี้ (ยังไม่แตะเซิร์ฟเวอร์):' -ForegroundColor Yellow
            Write-Info '  1. build frontend ที่เครื่องนี้'
            Write-Info '  2. แพ็กซอร์สที่ commit แล้วด้วย git archive'
            Write-Info "  3. อัปโหลดขึ้น $SshHost"
            Write-Info "  4. สำรอง .env + data/ เดิมไว้ แล้วสลับโค้ดใหม่เข้าที่ $RemoteApp"
            Write-Info '  5. bun install'
            Write-Info "  6. เผยแพร่ frontend ไปที่ $WebRoot"
            Write-Info "  7. รีสตาร์ต $BotService แล้วตรวจสุขภาพ"
            Write-Info '  8. พิมพ์คำสั่ง rollback ไว้ให้'
            return 0
        }

        Write-Head '1/6 build frontend ที่เครื่องนี้'
        & bun run --cwd frontend build
        if ($LASTEXITCODE -ne 0) { throw 'build frontend ไม่ผ่าน - ยกเลิก deploy' }
        Write-Ok 'build เสร็จ'

        Write-Head '2/6 แพ็กซอร์ส'
        $srcTar = Join-Path $env:TEMP 'linebot-src.tar.gz'
        $distTar = Join-Path $env:TEMP 'linebot-dist.tar.gz'
        & git archive --format=tar.gz -o $srcTar HEAD
        if ($LASTEXITCODE -ne 0) { throw 'git archive ล้มเหลว' }
        & tar -czf $distTar -C (Join-Path $PSScriptRoot 'frontend/dist') .
        if ($LASTEXITCODE -ne 0) { throw 'แพ็ก frontend dist ล้มเหลว' }
        Write-Ok "แพ็กเสร็จ ($([math]::Round((Get-Item $srcTar).Length/1MB,1)) MB)"

        Write-Head '3/6 อัปโหลด'
        & scp -i $SshKey $srcTar "${SshHost}:/tmp/linebot-src.tar.gz"
        if ($LASTEXITCODE -ne 0) { throw 'อัปโหลดซอร์สล้มเหลว' }
        & scp -i $SshKey $distTar "${SshHost}:/tmp/linebot-dist.tar.gz"
        if ($LASTEXITCODE -ne 0) { throw 'อัปโหลด frontend ล้มเหลว' }
        Remove-Item $srcTar, $distTar -Force -ErrorAction SilentlyContinue
        Write-Ok 'อัปโหลดเสร็จ'

        Write-Head '4/6 ติดตั้งบนเซิร์ฟเวอร์'
        $remote = @'
set -euo pipefail
APP="__APP__"
WEB="__WEB__"
BUN="__BUN__"

rm -rf "$APP.new"
mkdir -p "$APP.new"
tar -xzf /tmp/linebot-src.tar.gz -C "$APP.new"
rm -f /tmp/linebot-src.tar.gz

# ของที่ไม่ได้อยู่ใน git และห้ามหาย: ความลับกับฐานข้อมูลจริง
[ -f "$APP/backend/.env" ] && cp "$APP/backend/.env" "$APP.new/backend/.env"
[ -d "$APP/backend/data" ] && cp -r "$APP/backend/data" "$APP.new/backend/data"
# ไบนารี Go เดิม: ถ้าซอร์สไม่เปลี่ยน Bun จะใช้ตัวนี้ต่อโดยไม่ต้องคอมไพล์ใหม่
[ -f "$APP/backend/sender/sender" ] && cp "$APP/backend/sender/sender" "$APP.new/backend/sender/sender"
# node_modules เดิม เพื่อให้ bun install ทำงานแบบ incremental
[ -d "$APP/backend/node_modules" ] && cp -r "$APP/backend/node_modules" "$APP.new/backend/node_modules"

rm -rf "$APP.old"
mv "$APP" "$APP.old"
mv "$APP.new" "$APP"

cd "$APP/backend"
"$BUN" install --silent

sudo rm -rf "$WEB"/*
sudo tar -xzf /tmp/linebot-dist.tar.gz -C "$WEB"
sudo chown -R www-data:www-data "$WEB"
rm -f /tmp/linebot-dist.tar.gz
echo "ติดตั้งเสร็จ (สำรองของเดิมไว้ที่ $APP.old)"
'@.Replace('__APP__', $RemoteApp).Replace('__WEB__', $WebRoot).Replace('__BUN__', $script:BunPath)
        Invoke-Remote -Script $remote
        Write-Ok 'ติดตั้งเสร็จ'

        Write-Head '5/6 รีสตาร์ต backend'
        $restart = @'
set -uo pipefail
sudo systemctl restart __BOT__
sleep 12
systemctl is-active __BOT__
'@.Replace('__BOT__', $BotService)
        Invoke-Remote -Script $restart -AllowFailure
        if ($script:LastRemoteExit -ne 0) {
            Write-Bad 'backend ไม่ขึ้นหลัง deploy - แนะนำให้ rollback ทันที'
            Write-Host ''
            Write-Host 'คำสั่ง rollback:' -ForegroundColor Yellow
            Write-Host "  ssh -i `"$SshKey`" $SshHost 'rm -rf $RemoteApp && mv $RemoteApp.old $RemoteApp && sudo systemctl restart $BotService'"
            return 1
        }
        Write-Ok 'backend กลับมาแล้ว'

        Write-Head '6/6 ตรวจสุขภาพหลัง deploy'
        $null = Invoke-Check

        Write-Host ''
        Write-Host 'ถ้าพบปัญหา สั่ง rollback ได้ด้วย:' -ForegroundColor Yellow
        Write-Host "  ssh -i `"$SshKey`" $SshHost 'rm -rf $RemoteApp && mv $RemoteApp.old $RemoteApp && sudo systemctl restart $BotService'"
        return 0
    }
    finally {
        Pop-Location
    }
}

#endregion

#region ---------- 6. รีบูตเซิร์ฟเวอร์ ----------

function Restart-Server {
    Write-Head 'รีบูตเซิร์ฟเวอร์ทั้งเครื่อง'
    Write-Host ''
    Write-Warn 'นี่คือการรีบูตทั้งเครื่อง ไม่ใช่แค่รีสตาร์ต service'
    Write-Warn 'เว็บและบอทจะดับประมาณ 1-2 นาที'
    Write-Warn 'ถ้าต้องการแค่ให้บอทกลับมาทำงาน ใช้ตัวเลือก 3 (รีสตาร์ต Bun) แทน - เร็วกว่ามาก'
    Write-Host ''

    if (-not (Confirm-Action 'ยืนยันรีบูตทั้งเครื่อง?' -Expect 'REBOOT')) {
        Write-Info 'ยกเลิกแล้ว'
        return 1
    }

    Write-Info 'สั่งรีบูต...'
    # ยอมให้ล้มเหลวได้ เพราะการรีบูตจะตัด ssh ระหว่างทางเป็นเรื่องปกติ
    Invoke-Remote -Script 'sudo systemctl reboot || sudo reboot' -AllowFailure

    Write-Info 'รอเครื่องกลับมา...'
    for ($i = 1; $i -le 30; $i++) {
        Start-Sleep -Seconds 10
        $probe = & ssh -i $SshKey -o ConnectTimeout=8 -o BatchMode=yes -o StrictHostKeyChecking=no $SshHost 'echo up' 2>$null
        if ($probe -match 'up') {
            Write-Ok "เครื่องกลับมาแล้ว (ใช้เวลา ~$($i*10) วินาที)"
            Start-Sleep -Seconds 10
            return (Invoke-Check)
        }
        Write-Info "  ยังไม่กลับมา... ($($i*10)s)"
    }
    Write-Bad 'เครื่องไม่กลับมาใน 5 นาที - ตรวจสอบที่ AWS Console'
    return 1
}

#endregion

#region ---------- เมนู ----------

function Show-Menu {
    while ($true) {
        Write-Host ''
        Write-Host '============================================' -ForegroundColor Cyan
        Write-Host '   จัดการ LINE Bot - AWS' -ForegroundColor Cyan
        Write-Host "   $SshHost" -ForegroundColor DarkGray
        Write-Host '============================================' -ForegroundColor Cyan
        Write-Host '  1) Deploy ขึ้น AWS'
        Write-Host '  2) รีสตาร์ต Go relay (คอมไพล์ใหม่ + รีสตาร์ต backend)'
        Write-Host '  3) รีสตาร์ต Bun backend'
        Write-Host '  4) รีสตาร์ต Nginx'
        Write-Host '  5) ตรวจสอบสถานะทั้งหมด (ปลอดภัย ไม่แตะอะไร)' -ForegroundColor Green
        Write-Host '  6) รีบูตเซิร์ฟเวอร์ทั้งเครื่อง' -ForegroundColor Yellow
        Write-Host '  7) Deploy แบบ DryRun (ดูว่าจะทำอะไร ไม่แตะจริง)'
        Write-Host '  0) ออก'
        Write-Host ''

        $choice = Read-Host 'เลือก'
        switch ($choice) {
            '1' { $null = Invoke-Deploy }
            '2' { $null = Restart-Backend -RebuildGo }
            '3' { $null = Restart-Backend }
            '4' { $null = Restart-Nginx }
            '5' { $null = Invoke-Check }
            '6' { $null = Restart-Server }
            '7' { $script:DryRun = $true; $null = Invoke-Deploy; $script:DryRun = $false }
            '0' { return 0 }
            default { Write-Warn 'เลือกไม่ถูกต้อง' }
        }
    }
}

#endregion

Assert-Prerequisites

switch ($Action) {
    'deploy' { exit (Invoke-Deploy) }
    'restart-go' { exit (Restart-Backend -RebuildGo) }
    'restart-bun' { exit (Restart-Backend) }
    'restart-nginx' { exit (Restart-Nginx) }
    'check' { exit (Invoke-Check) }
    'reboot' { exit (Restart-Server) }
    'menu' { exit (Show-Menu) }
}
