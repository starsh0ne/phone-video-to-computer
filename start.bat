@echo off
chcp 65001 >nul
title local-cast 投屏服务

echo ==================================================
echo    local-cast 本地投屏工具 启动中...
echo ==================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js 18 以上版本后重试。
    echo 下载地址: https://nodejs.org/
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo 首次运行，正在安装依赖（仅一次，需要联网）...
    call npm install
    if errorlevel 1 (
        echo [错误] 依赖安装失败，请检查网络后重试。
        pause
        exit /b 1
    )
)

echo 正在启动投屏服务...
echo.
echo 启动后请在电脑浏览器打开：http://localhost:8080/
echo 用手机扫描页面上的二维码即可投屏。
echo 关闭本窗口或按 Ctrl+C 可停止服务。
echo.

node server\server.js

pause
