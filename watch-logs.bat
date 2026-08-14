@echo off
setlocal

set ROOT=%~dp0
set SSH_KEY=%ROOT%maxpc.pem
set SSH_HOST=admin@3.112.61.130
set SERVICE=linebot-backend

where ssh >nul 2>nul
if errorlevel 1 (
	echo [watch-logs.bat] ERROR: "ssh" was not found on PATH. Install OpenSSH Client first.
	pause
	exit /b 1
)

if not exist "%SSH_KEY%" (
	echo [watch-logs.bat] ERROR: SSH key not found at "%SSH_KEY%".
	pause
	exit /b 1
)

echo [watch-logs.bat] Streaming live logs from %SSH_HOST% (%SERVICE%)...
echo [watch-logs.bat] Press Ctrl+C to stop watching. This does not stop the bot.
echo.

:loop
ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 %SSH_HOST% "journalctl -u %SERVICE% -f --no-hostname -o cat"
echo.
echo [watch-logs.bat] Connection dropped — reconnecting in 3s... (Ctrl+C to quit)
timeout /t 3 /nobreak >nul
goto loop
