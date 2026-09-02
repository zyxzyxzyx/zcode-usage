@echo off
title ZCode Token Usage Widget
cd /d "%~dp0widget"

if not exist "node_modules\electron\dist\electron.exe" (
  echo First run: installing dependencies, please wait...
  set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
  call npm install --no-audit --no-fund
  if not exist "node_modules\electron\dist\electron.exe" (
    echo.
    echo Install failed. Check network and retry.
    pause
    exit /b 1
  )
)

start "" "%~dp0widget\node_modules\electron\dist\electron.exe" "%~dp0widget"
exit /b 0
