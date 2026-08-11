@echo off
setlocal
cd /d "%~dp0"

rem Relaunch this installer as Administrator when needed.
fltmc >nul 2>&1
if errorlevel 1 (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
        "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

echo Installing AI Image for Adobe Photoshop 2026...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1"
if errorlevel 1 (
    echo.
    echo Installation failed. Please send a screenshot of this window.
    pause
    exit /b 1
)

echo.
echo Done. Restart Photoshop and open Plugins - AI Image.
pause
