@echo off
REM ============================================================
REM  Douyin live viewer-count collector - local server launcher
REM
REM  Why this file exists: Windows client defaults to the
REM  "Restricted" PowerShell execution policy, so running
REM  start_server.ps1 fails with "running scripts is disabled".
REM  Batch files are not affected by that policy.
REM
REM  IMPORTANT: this file is intentionally ASCII-only.
REM  cmd.exe mis-parses UTF-8 multi-byte characters (it tracks
REM  byte offsets while reading the script), which silently
REM  corrupts execution. Keep it ASCII. Chinese docs: README.md
REM ============================================================

setlocal
cd /d "%~dp0"
set "PORT=8787"
set "VENV_PY=%~dp0.venv\Scripts\python.exe"

REM ---- already running? just open the dashboard ----
netstat -ano | findstr ":%PORT%" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
    echo [!] Port %PORT% is already in use - server looks running.
    echo     Opening http://127.0.0.1:%PORT%/
    start "" "http://127.0.0.1:%PORT%/"
    exit /b 0
)

if exist "%VENV_PY%" goto :run

echo [1/3] No .venv found, looking for a usable Python ...
set "PY="

for %%P in (
    "%ProgramData%\Anaconda3\python.exe"
    "%USERPROFILE%\anaconda3\python.exe"
    "%USERPROFILE%\miniconda3\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
) do (
    if not defined PY if exist %%P set "PY=%%~P"
)

if not defined PY (
    REM the Microsoft Store python.exe is just a stub - filter it out
    for /f "delims=" %%i in ('where python 2^>nul ^| findstr /i /v "WindowsApps"') do (
        if not defined PY set "PY=%%i"
    )
)

if not defined PY (
    echo [x] No usable Python found. Install Python 3.10+ first.
    echo     https://www.python.org/downloads/
    pause
    exit /b 1
)

echo       using: %PY%
echo [2/3] Creating virtualenv .venv ...
"%PY%" -m venv "%~dp0.venv"
if errorlevel 1 (
    echo [x] Failed to create virtualenv.
    pause
    exit /b 1
)

echo [3/3] Installing dependencies ...
"%~dp0.venv\Scripts\python.exe" -m pip install --quiet --upgrade pip
"%~dp0.venv\Scripts\python.exe" -m pip install --quiet -r "%~dp0server\requirements.txt"
if errorlevel 1 (
    echo [x] Failed to install dependencies. Check your network.
    pause
    exit /b 1
)

:run
echo.
echo ============================================================
echo   Dashboard : http://127.0.0.1:%PORT%/
echo   Stop      : press Ctrl+C
echo ============================================================
echo.
REM set DYLIVE_NO_BROWSER=1 to run without opening a browser
if not defined DYLIVE_NO_BROWSER start "" "http://127.0.0.1:%PORT%/"
"%~dp0.venv\Scripts\python.exe" -m uvicorn app:app --host 127.0.0.1 --port %PORT% --app-dir "%~dp0server"

echo.
echo Server stopped.
pause
