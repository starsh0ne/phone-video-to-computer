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

echo 正在为投屏服务放行防火墙端口（8080 电脑端 / 8081 手机端，允许手机访问）...
netsh advfirewall firewall add rule name="local-cast 投屏服务 HTTP" dir=in action=allow localport=8080 protocol=TCP >nul 2>nul
netsh advfirewall firewall add rule name="local-cast 投屏服务 HTTPS" dir=in action=allow localport=8081 protocol=TCP >nul 2>nul
if errorlevel 1 (
    echo 提示：防火墙规则未添加成功（可能已存在或需要管理员权限），如手机无法连接请手动放行 8080/8081 端口。
) else (
    echo 防火墙规则已放行。
)

echo 正在启动投屏服务...
echo.
echo 启动后请在电脑浏览器打开：http://localhost:8080/
echo ├─ Android 手机：接收页右侧「无线投屏」面板，按提示开启无线调试并配对（首次需联网下载工具）
echo └─ iOS 27+ Safari：扫码直投（首次访问需点「继续前往」确认证书）
echo 关闭本窗口或按 Ctrl+C 可停止服务。
echo.

node server\server.js

pause
