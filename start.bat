@echo off
chcp 65001 >nul
title local-cast 鎶曞睆鏈嶅姟

echo ==================================================
echo    local-cast 鏈湴鎶曞睆宸ュ叿 鍚姩涓?..
echo ==================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [閿欒] 鏈娴嬪埌 Node.js锛岃鍏堝畨瑁?Node.js 18 浠ヤ笂鐗堟湰鍚庨噸璇曘€?
    echo 涓嬭浇鍦板潃: https://nodejs.org/
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo 棣栨杩愯锛屾鍦ㄥ畨瑁呬緷璧栵紙浠呬竴娆★紝闇€瑕佽仈缃戯級...
    call npm install
    if errorlevel 1 (
        echo [閿欒] 渚濊禆瀹夎澶辫触锛岃妫€鏌ョ綉缁滃悗閲嶈瘯銆?
        pause
        exit /b 1
    )
)

echo 姝ｅ湪涓烘姇灞忔湇鍔℃斁琛岄槻鐏绔彛锛?080 鐢佃剳绔?/ 8081 鎵嬫満绔紝鍏佽鎵嬫満璁块棶锛?..
netsh advfirewall firewall add rule name="local-cast 鎶曞睆鏈嶅姟 HTTP" dir=in action=allow localport=8080 protocol=TCP >nul 2>nul
netsh advfirewall firewall add rule name="local-cast 鎶曞睆鏈嶅姟 HTTPS" dir=in action=allow localport=8081 protocol=TCP >nul 2>nul
if errorlevel 1 (
    echo 鎻愮ず锛氶槻鐏瑙勫垯鏈坊鍔犳垚鍔燂紙鍙兘宸插瓨鍦ㄦ垨闇€瑕佺鐞嗗憳鏉冮檺锛夛紝濡傛墜鏈烘棤娉曡繛鎺ヨ鎵嬪姩鏀捐 8080/8081 绔彛銆?
) else (
    echo 闃茬伀澧欒鍒欏凡鏀捐銆?
)

echo 姝ｅ湪鍚姩鎶曞睆鏈嶅姟...
echo.
echo 鍚姩鍚庤鍦ㄧ數鑴戞祻瑙堝櫒鎵撳紑锛歨ttp://localhost:8080/
echo 鈹溾攢 Android 鎵嬫満锛氭帴鏀堕〉鍙充晶銆屾棤绾挎姇灞忋€嶉潰鏉匡紝鎸夋彁绀哄紑鍚棤绾胯皟璇曞苟閰嶅锛堥娆￠渶鑱旂綉涓嬭浇宸ュ叿锛?
echo 鈹斺攢 iOS 27+ Safari锛氭壂鐮佺洿鎶曪紙棣栨璁块棶闇€鐐广€岀户缁墠寰€銆嶇‘璁よ瘉涔︼級
echo 鍏抽棴鏈獥鍙ｆ垨鎸?Ctrl+C 鍙仠姝㈡湇鍔°€?
echo.

node server\index.js

pause
