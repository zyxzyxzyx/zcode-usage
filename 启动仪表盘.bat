@echo off
chcp 65001 >nul
title ZCode Token 用量仪表盘
cd /d "%~dp0"
echo 正在启动 ZCode Token 用量仪表盘...
node server/index.ts
echo.
echo 服务已退出。如果上方报错，请确认已安装 Node.js 22.5+。
pause
