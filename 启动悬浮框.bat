@echo off
chcp 65001 >nul
title ZCode 用量悬浮框
cd /d "%~dp0widget"

if not exist "node_modules\electron\dist\electron.exe" (
  echo 首次运行，安装依赖（约 1-2 分钟）...
  set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
  call npm install --no-audit --no-fund
  if not exist "node_modules\electron\dist\electron.exe" (
    echo.
    echo 安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

start "" "%~dp0widget\node_modules\electron\dist\electron.exe" "%~dp0widget"
echo 悬浮框已启动（常驻托盘，右上角悬浮卡）。
