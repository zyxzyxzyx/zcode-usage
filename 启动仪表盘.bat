@echo off
title ZCode Usage Dashboard (watchdog)
cd /d "%~dp0"
echo ============================================
echo  ZCode Usage Dashboard - watchdog mode
echo  Auto-restarts on crash. Close window to stop.
echo ============================================

:loop
rem Recreate log when larger than 5MB
if exist data\server.log for %%F in (data\server.log) do if %%~zF GTR 5000000 del data\server.log
node server/index.ts >> data\server.log 2>&1
echo [%date% %time%] server exited, restarting in 3s...
timeout /t 3 /nobreak >nul
goto loop
