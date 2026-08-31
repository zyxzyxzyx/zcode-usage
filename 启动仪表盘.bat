@echo off
chcp 65001 >nul
title ZCode Token 用量仪表盘（看护模式）
cd /d "%~dp0"
echo ============================================
echo  ZCode Token 用量仪表盘 - 看护模式
echo  服务意外退出时会自动重启（关闭本窗口即停止）
echo ============================================

:loop
rem 日志超过 5MB 时重建，避免无限增长
if exist data\server.log for %%F in (data\server.log) do if %%~zF GTR 5000000 del data\server.log
node server/index.ts >> data\server.log 2>&1
echo [%date% %time%] 服务退出，3 秒后自动重启...
timeout /t 3 /nobreak >nul
goto loop
