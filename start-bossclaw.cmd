@echo off
setlocal EnableExtensions
REM ============================================================
REM  BossClaw Desktop Launcher
REM
REM  Default                        : FAST PATH - launch the last build in
REM                                    dist/ directly (no Vite server). If
REM                                    sources changed it rebuilds first.
REM  start-bossclaw.cmd --dev       : start Vite dev server (HMR) + Electron.
REM  start-bossclaw.cmd --visible   : keep the console open and show logs.
REM  start-bossclaw.cmd --no-agent : do NOT enable the local agent bridge
REM                                 (MCP / control bridge is ON by default).
REM  Flags can be combined, e.g.  --dev --visible
REM ============================================================

REM ---- self-hide: relaunch hidden, preserving original arguments ----
REM      (except --visible: debug mode keeps the current console so logs are visible)
if /i "%~1"=="--hidden" goto :run
echo %* | findstr /I /C:"--visible" >nul 2>&1 && goto :run
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -WindowStyle Hidden -FilePath '%~f0' -ArgumentList '--hidden %*'"
exit /b 0

:run
REM ---- parse flags (args include the injected --hidden) ----
set "MODE=dist"
set "VISIBLE="
echo %* | findstr /I /C:"--dev"     >nul 2>&1 && set "MODE=dev"
echo %* | findstr /I /C:"--visible" >nul 2>&1 && set "VISIBLE=1"

REM ---- visible mode: also write the renderer debug log (debug-render.log) ----
if defined VISIBLE set "BOSSCLAW_DEBUG=1"

REM ---- detect a sandboxed runtime (WorkBuddy etc.) BEFORE clearing env ----
REM      Chromium needs --no-sandbox there; normal machines skip it.
set "NO_SANDBOX="
echo.%NODE_OPTIONS% | findstr /C:"genie-safe-delete" >nul 2>&1 && set "NO_SANDBOX=--no-sandbox"

REM ---- clear sandbox-injected vars (harmless on a normal machine) ----
set "NODE_OPTIONS="
set "ELECTRON_RUN_AS_NODE="
set "PYTHONPATH="

REM ---- local agent bridge (MCP): ON by default for this launcher ----
REM      Enables electron/control-bridge.cjs (127.0.0.1 + token, port 17650) and the
REM      'no API key -> let the agent answer' fallback.
REM      Passed as a CLI switch instead of an env var, because this script starts
REM      Electron through a shortcut (env inheritance is less reliable than argv).
REM      Turn it off with:  start-bossclaw.cmd --no-agent
set "AGENT_FLAG=--control-bridge"
echo %* | findstr /I /C:"--no-agent" >nul 2>&1 && set "AGENT_FLAG="
if defined AGENT_FLAG echo [INFO] Agent bridge ON (MCP can control this instance).


REM ---- locate the app folder ----
cd /d "%~dp0" 2>nul || goto :fail
set "APP_DIR=%~dp0desktop-app"
if not exist "%APP_DIR%" (set "ERRMSG=desktop-app folder not found next to this script" & goto :fail)
cd /d "%APP_DIR%" 2>nul || goto :fail

REM ---- taskbar name fix: launch via a shortcut so Windows shows "BossClaw" instead of "Electron" ----
set "SC_DIR=%LOCALAPPDATA%\BossClaw"
if not exist "%SC_DIR%" mkdir "%SC_DIR%"
set "ELECTRON_EXE=%APP_DIR%\node_modules\electron\dist\electron.exe"
set "ICON_PATH=%APP_DIR%\resources\icon.ico"

REM ---- preflight checks ----
where node >nul 2>&1 || (set "ERRMSG=Node.js not found in PATH" & goto :fail)
if not exist "node_modules\vite\bin\vite.js"           (set "ERRMSG=node_modules missing, run npm install first" & goto :fail)
if not exist "node_modules\electron\dist\electron.exe" (set "ERRMSG=electron binary missing, run npm install in desktop-app" & goto :fail)

REM ---- kill stale processes from previous runs (single fast PowerShell pass) ----
REM      1) this project's Electron instances (main + renderer + gpu + bridge)
REM      2) anything listening on dev ports 5173-5179 (stale Vite)
REM      3) Camoufox Python bridge - only needed when starting the dev server
echo [INFO] Cleaning up stale BossClaw processes ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*desktop-app*' } | Stop-Process -Force -ErrorAction SilentlyContinue; Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -ge 5173 -and $_.LocalPort -le 5179 } | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; if('%MODE%' -eq 'dev'){ Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^python' -and $_.CommandLine -like '*camoufox_server.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }"

if /i "%MODE%"=="dev" goto :dev_mode

REM ==================== FAST PATH (default): launch dist build ====================
if not exist "dist\index.html" goto :rebuild
node "scripts\check-fresh.mjs" >nul 2>&1
if errorlevel 1 goto :rebuild
echo [INFO] Launching BossClaw (build is up-to-date) ...
set "SC_PATH=%SC_DIR%\BossClaw.lnk"
powershell -NoProfile -Command "$ws=New-Object -ComObject WScript.Shell; $sc=$ws.CreateShortcut('%SC_PATH%'); $sc.TargetPath='%ELECTRON_EXE%'; $sc.Arguments='. %NO_SANDBOX% %AGENT_FLAG%'; $sc.WorkingDirectory='%APP_DIR%'; $sc.IconLocation='%ICON_PATH%,0'; $sc.Description='BossClaw'; $sc.Save()" >nul 2>&1
if exist "%SC_PATH%" (
  start "" "%SC_PATH%"
) else (
  echo [WARN] Shortcut creation failed, falling back to direct launch ...
  start "" "%ELECTRON_EXE%" . %NO_SANDBOX% %AGENT_FLAG%
)
echo [OK] BossClaw launched in background. Close it from the taskbar or Task Manager.
if defined VISIBLE pause
exit /b 0

:rebuild
echo [INFO] Sources changed (or first run) - rebuilding, about 15s ...
node "node_modules\vite\bin\vite.js" build
if errorlevel 1 (set "ERRMSG=vite build failed" & goto :fail)
echo [INFO] Build OK. Launching BossClaw ...
set "SC_PATH=%SC_DIR%\BossClaw.lnk"
powershell -NoProfile -Command "$ws=New-Object -ComObject WScript.Shell; $sc=$ws.CreateShortcut('%SC_PATH%'); $sc.TargetPath='%ELECTRON_EXE%'; $sc.Arguments='. %NO_SANDBOX% %AGENT_FLAG%'; $sc.WorkingDirectory='%APP_DIR%'; $sc.IconLocation='%ICON_PATH%,0'; $sc.Description='BossClaw'; $sc.Save()" >nul 2>&1
if exist "%SC_PATH%" (
  start "" "%SC_PATH%"
) else (
  echo [WARN] Shortcut creation failed, falling back to direct launch ...
  start "" "%ELECTRON_EXE%" . %NO_SANDBOX% %AGENT_FLAG%
)
echo [OK] BossClaw launched in background. Close it from the taskbar or Task Manager.
if defined VISIBLE pause
exit /b 0

REM ==================== DEV MODE: Vite dev server + HMR ====================
:dev_mode
echo [INFO] Starting Vite dev server on 127.0.0.1:5173 ...
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -WindowStyle Hidden node.exe -ArgumentList 'node_modules\vite\bin\vite.js --port 5173 --host 127.0.0.1 --strictPort' -WorkingDirectory '%CD%'"
powershell -NoProfile -Command "$deadline=(Get-Date).AddSeconds(12); do { try { $r=Invoke-WebRequest -Uri http://127.0.0.1:5173 -UseBasicParsing -TimeoutSec 1; if($r.StatusCode -lt 400){ exit 0 } } catch {}; Start-Sleep -Milliseconds 600 } while((Get-Date) -lt $deadline); exit 1"
if errorlevel 1 echo [WARN] Vite not ready in time - Electron will fall back to the last build
echo [INFO] Launching Electron (dev mode) ...
set "SC_PATH=%SC_DIR%\BossClaw-Dev.lnk"
powershell -NoProfile -Command "$ws=New-Object -ComObject WScript.Shell; $sc=$ws.CreateShortcut('%SC_PATH%'); $sc.TargetPath='%ELECTRON_EXE%'; $sc.Arguments='. --dev %NO_SANDBOX% %AGENT_FLAG%'; $sc.WorkingDirectory='%APP_DIR%'; $sc.IconLocation='%ICON_PATH%,0'; $sc.Description='BossClaw (Dev)'; $sc.Save()" >nul 2>&1
if exist "%SC_PATH%" (
  start "" "%SC_PATH%"
) else (
  echo [WARN] Shortcut creation failed, falling back to direct launch ...
  start "" "%ELECTRON_EXE%" . --dev %NO_SANDBOX% %AGENT_FLAG%
)
echo [OK] BossClaw launched in background. Close it from the taskbar or Task Manager.
if defined VISIBLE pause
exit /b 0

:fail
echo [ERROR] %ERRMSG%
if defined VISIBLE (
    pause
) else (
    powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('%ERRMSG%','BossClaw Error','OK','Error')" >nul 2>&1
)
exit /b 1
