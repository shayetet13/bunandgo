@echo off
setlocal

rem Live log for bot "Big sa" (id 117), room "กลุ่มรับงาน กระทุ่มแบน V2."
rem Real backend runs on Server 2 (10.77.0.2), reached via ProxyJump through
rem Server 1 (3.112.61.130). Server 1's own linebot-backend is intentionally
rem stopped, so this does NOT touch that host's service.

set "SSH_KEY=C:\Users\Administrator\.ssh\linebot-maxpc.pem"
set "GATEWAY=admin@3.112.61.130"
set "TARGET=linebot@10.77.0.2"
set "SERVICES=linebot-worker and linebot-worker-shard-b"
set "LOG_DIR=%~dp0logs"

for /f %%I in ('powershell.exe -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%I"
if not defined STAMP (
	echo [watch-log-bigsa.bat] ERROR: Could not create a timestamp.
	pause
	exit /b 1
)
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
if errorlevel 1 (
	echo [watch-log-bigsa.bat] ERROR: Could not create "%LOG_DIR%".
	pause
	exit /b 1
)
set "LOG_FILE=%LOG_DIR%\bigsa-%STAMP%.log"

rem Snapshot only operational topology keys. CONTROL_PLANE_TOKEN and every
rem other secret are intentionally absent. The journal stream itself is not
rem filtered, preserving exact ordering across both services for correlation.
set "REMOTE_CMD=set -eu; echo '=== watcher snapshot begin ==='; date -Is; for unit in linebot-worker linebot-worker-shard-b; do state=$(systemctl is-active $unit 2>/dev/null || true); pid=$(systemctl show -p MainPID --value $unit 2>/dev/null || echo 0); echo SERVICE unit=$unit active=${state:-unknown} MainPID=${pid:-0}; if [ ${pid:-0} -gt 0 ] && [ -r /proc/$pid/environ ]; then tr '\0' '\n' < /proc/$pid/environ | grep -E '^(WORKER_ID|WORKER_ASSIGNMENT_MODE|WORKER_ASSIGNMENT_WORKERS|WORKER_PRIMARY_ID|WORKER_ROUTES|CONTROL_PLANE_URL|PORT|DISPATCH_ADDR|LINE_H2_LANES|LINE_EFFECTIVE_H2_LANES|LINE_RELAY_MODE|SQUARE_FAST_POLL_INTERVAL_MS|SQUARE_FAST_POLL_SLOTS)=' | sort || true; fi; done; echo '--- bot inventory: id|name|owner_user_id|status ---'; if command -v sqlite3 >/dev/null 2>&1; then sqlite3 -header -separator '|' /opt/linebot/shared/worker.db 'SELECT id, replace(replace(name,char(10),char(32)),char(13),char(32)) AS name, COALESCE(CAST(owner_user_id AS TEXT),char(45)) AS owner_user_id, status FROM bots ORDER BY id;' || echo '[snapshot] bot inventory query failed'; echo '--- sticky assignments: owner_user_id|worker_id ---'; sqlite3 -header -separator '|' /opt/linebot/shared/worker.db 'SELECT owner_user_id,worker_id FROM owner_worker_assignments ORDER BY owner_user_id;' || true; else echo '[snapshot] sqlite3 is unavailable'; fi; echo '=== watcher snapshot end; raw journal follows ==='; exec journalctl -u linebot-worker -u linebot-worker-shard-b -n 200 -f --no-hostname -o short-iso-precise"

where ssh >nul 2>nul
if errorlevel 1 (
	echo [watch-log-bigsa.bat] ERROR: "ssh" was not found on PATH. Install OpenSSH Client first.
	pause
	exit /b 1
)

if not exist "%SSH_KEY%" (
	echo [watch-log-bigsa.bat] ERROR: SSH key not found at "%SSH_KEY%".
	pause
	exit /b 1
)

title bigsa log - กลุ่มรับงาน กระทุ่มแบน V2
echo [watch-log-bigsa.bat] Bot: Big sa (id 117)
echo [watch-log-bigsa.bat] Room: กลุ่มรับงาน กระทุ่มแบน V2. (mid mbbac8f7ae4b5d5121ff258d0a71cf736)
echo [watch-log-bigsa.bat] Source: Server 2 (10.77.0.2), services %SERVICES%, via Server 1 gateway
echo [watch-log-bigsa.bat] Capturing ALL bot and infrastructure lines so cross-bot CPU, sender,
echo [watch-log-bigsa.bat] restart, scope, and system-load evidence is not discarded.
echo [watch-log-bigsa.bat] Local raw copy: "%LOG_FILE%"
echo [watch-log-bigsa.bat] Snapshot includes service/PID, non-secret effective topology, and all bots.
echo [watch-log-bigsa.bat] Press Ctrl+C to stop watching. This does not stop the bot.
echo.

:loop
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$sshArgs = @('-i', $env:SSH_KEY, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30', '-o', ('ProxyCommand=ssh -i ' + $env:SSH_KEY + ' -W 10.77.0.2:22 ' + $env:GATEWAY), $env:TARGET, $env:REMOTE_CMD); & ssh.exe @sshArgs 2>&1 | Tee-Object -FilePath $env:LOG_FILE -Append; exit $LASTEXITCODE"
echo.
echo [watch-log-bigsa.bat] Connection dropped - reconnecting in 3s and appending to the same file... (Ctrl+C to quit)
timeout /t 3 /nobreak >nul
goto loop
