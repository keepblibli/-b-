@echo off
REM ============================================================
REM  Build a transfer package for another computer.
REM
REM  Excludes: .venv (machine-specific absolute paths), server\data
REM  (history - copy it by hand if you want to keep it),
REM  __pycache__, .tmp, and any previous package zip.
REM
REM  IMPORTANT: ASCII only. cmd.exe tracks byte offsets while
REM  reading a .bat, so UTF-8 multi-byte characters corrupt the
REM  parse and it ends up executing garbage. Docs: README.md
REM ============================================================

setlocal
cd /d "%~dp0"
set "PROJECT_DIR=%CD%"
set "OUT=%PROJECT_DIR%\..\live-monitor-package.zip"

for %%I in ("%PROJECT_DIR%") do set "PROJECT_NAME=%%~nxI"

echo Project : %PROJECT_NAME%
echo Output  : %OUT%
echo.

REM tar.exe ships with Windows 10 1803+ ; no PowerShell needed
where tar >nul 2>nul
if errorlevel 1 (
    echo [x] tar.exe not found. Windows 10 1803+ is required,
    echo     or zip the folder by hand, skipping .venv and server\data
    pause
    exit /b 1
)

if exist "%OUT%" del "%OUT%"

pushd "%PROJECT_DIR%\.."
tar -a -c -f "%OUT%" ^
    --exclude="%PROJECT_NAME%/.venv" ^
    --exclude="%PROJECT_NAME%/server/data" ^
    --exclude="%PROJECT_NAME%/server/__pycache__" ^
    --exclude="%PROJECT_NAME%/.tmp" ^
    --exclude="%PROJECT_NAME%/.deps" ^
    --exclude="%PROJECT_NAME%/.pkgcheck" ^
    --exclude="%PROJECT_NAME%/*.log" ^
    --exclude="%PROJECT_NAME%/*.zip" ^
    "%PROJECT_NAME%"
set "RC=%ERRORLEVEL%"
popd

if not "%RC%"=="0" (
    echo [x] tar failed with code %RC%
    pause
    exit /b 1
)

echo.
echo === package contents, top level ===
tar -tf "%OUT%" | findstr /r "^%PROJECT_NAME%/[^/]*$"
echo.
echo === size ===
for %%A in ("%OUT%") do echo %%~zA bytes
echo.
echo Done. Copy the zip to the new computer and follow docs\DEPLOY.md
pause
