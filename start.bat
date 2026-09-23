@echo off
setlocal

set ROOT=%~dp0

where bun >nul 2>nul
if errorlevel 1 (
	echo [start.bat] ERROR: "bun" was not found on PATH. Install it first: https://bun.sh
	pause
	exit /b 1
)

if not exist "%ROOT%backend\node_modules" (
	echo [start.bat] Installing backend dependencies...
	pushd "%ROOT%backend"
	call bun install
	popd
)

if not exist "%ROOT%frontend\node_modules" (
	echo [start.bat] Installing frontend dependencies...
	pushd "%ROOT%frontend"
	call bun install
	popd
)

echo [start.bat] Starting backend (Bun API + Go sender) in a new window...
rem AboveNormal reduces scheduler jitter without the starvation risk of
rem High/Realtime. The backend's children inherit this priority class.
start "LINE Bot Backend" /abovenormal cmd /k "cd /d "%ROOT%backend" && bun run start"

echo [start.bat] Waiting for backend to come up...
timeout /t 3 /nobreak >nul

echo [start.bat] Starting frontend (Vite dashboard) in a new window...
start "LINE Bot Frontend" cmd /k "cd /d "%ROOT%frontend" && bun run dev"

echo.
echo   Backend:   http://localhost:8787
echo   Frontend:  http://localhost:5173
echo.
echo Two windows were opened for backend/frontend logs. Close them to stop.
pause
