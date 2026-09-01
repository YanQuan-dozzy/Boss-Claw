@echo off
setlocal EnableExtensions
chcp 65001 >nul
REM ============================================================
REM  BossClaw - One-click environment installer (Windows)
REM
REM  What it installs (all runtime deps are downloaded here,
REM  they are NOT committed to the repository):
REM    1) Node.js dependencies + Electron binary  (npm install)
REM    2) [Optional] Python stealth engine (camoufox + playwright)
REM
REM  Usage: double-click this file, or run:   install-deps.cmd
REM ============================================================

cd /d "%~dp0"
set "APP_DIR=%~dp0desktop-app"

echo.
echo ============================================
echo  BossClaw environment setup
echo ============================================

REM ---- 0. Node.js check ----
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found in PATH.
    echo         Install Node.js 18+ from https://nodejs.org and re-run.
    goto :end
)
for /f "delims=" %%v in ('node -v') do set "NODE_VER=%%v"
echo [1/4] Node.js detected: %NODE_VER%

REM ---- 1. npm install ----
cd /d "%APP_DIR%"
echo [2/4] Installing Node dependencies (npm install, may take a few minutes)...
call npm install --no-audit --no-fund
if errorlevel 1 (
    echo [WARN] npm install failed - retrying with npmmirror registry...
    call npm install --no-audit --no-fund --registry=https://registry.npmmirror.com
    if errorlevel 1 (
        echo [ERROR] npm install failed. Check your network / proxy settings.
        goto :end
    )
)

REM ---- 2. Electron binary check ----
echo [3/4] Checking Electron binary...
if not exist "node_modules\electron\dist\electron.exe" (
    echo [INFO] Electron binary missing - downloading via npmmirror mirror...
    set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
    call node node_modules/electron/install.js
    if errorlevel 1 (
        echo [WARN] Electron binary download failed. You can retry later with:
        echo        set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
        echo        node node_modules/electron/install.js
    )
)

REM ---- 3. Python stealth engine (optional) ----
echo [4/4] Optional setup: Python stealth engine (camoufox).
echo        Only needed for the hidden-engine (hidden search / hidden send) feature.
set "SETUP_PY="
set /p SETUP_PY="Setup Python environment now? [y/N] "
if /i "%SETUP_PY%"=="y" call :setup_python

:done
echo.
echo ============================================
echo  Setup finished.
echo  Start the app:   start-bossclaw.cmd
echo  Package installer: cd desktop-app ^&^& npm run package
echo ============================================
goto :end

:setup_python
where python >nul 2>&1
if errorlevel 1 (
    echo [WARN] Python not found in PATH. Skip.
    echo        Install Python 3.10+ from https://www.python.org if you need the stealth engine.
    exit /b 0
)
echo [INFO] Creating Python venv at desktop-app\.venv ...
python -m venv ".venv"
if errorlevel 1 (
    echo [ERROR] Failed to create venv. Skip.
    exit /b 1
)
echo [INFO] Installing camoufox + playwright into venv ...
".venv\Scripts\python.exe" -m pip install --upgrade pip -q
".venv\Scripts\python.exe" -m pip install -r "camoufox\requirements.txt"
if errorlevel 1 (
    echo [WARN] pip install failed - retrying with Tsinghua mirror...
    ".venv\Scripts\python.exe" -m pip install -r "camoufox\requirements.txt" -i https://pypi.tuna.tsinghua.edu.cn/simple
)
echo [INFO] Required: download camoufox fingerprint core (~150MB)?
echo        Local Chrome / Edge are NOT reusable - the stealth engine is unavailable without the core.
set "FETCH_CORE="
set /p FETCH_CORE="Download camoufox core now? [y/N] "
if /i "%FETCH_CORE%"=="y" ".venv\Scripts\python.exe" -m camoufox fetch
exit /b 0

:end
echo.
pause
endlocal
