/**
 * local-cast 服务入口（薄启动层）。
 *
 * 双端口设计（屏幕采集需要「安全上下文」，见 docs/01-技术方案.md）：
 *  - 8080 (HTTP)：电脑端接收页。localhost 被浏览器视为安全上下文，无需证书
 *  - 8081 (HTTPS)：手机端投屏页。getDisplayMedia 仅在 HTTPS 安全上下文可用，
 *    使用自签名证书（首次启动自动生成于 certs/ 目录），手机首次访问需点「继续前往」
 *
 * 装配关系：
 *  - HTTP/HTTPS 请求 → 本文件的路由（静态资源 + /api/session）
 *  - upgrade /ws     → cast-code.js（投屏码 WebRTC 信令）
 *  - upgrade /wireless → wireless/（ADB + scrcpy 无线投屏通道）
 *
 * 各子系统职责见 docs/architecture.md。
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { PORT_HTTP, PORT_HTTPS, PUBLIC_DIR, MIME, getLanIP } = require('./config');
const { ensureCert } = require('./cert');
const castCode = require('./cast-code');
const { setupWireless } = require('./wireless');

/* ---------------- HTTP 路由 ---------------- */

function serveStatic(req, res, urlPath) {
  let filePath = path.join(PUBLIC_DIR, urlPath === '/' ? 'receive.html' : urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function requestHandler(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT_HTTP}`);

  if (url.pathname === '/api/session' && req.method === 'GET') {
    castCode.handleSessionRequest(req, res, url).catch((err) => {
      console.error('[api/session] 生成会话失败:', err);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String((err && err.message) || err) }));
    });
    return;
  }
  if (url.pathname === '/' || url.pathname === '/receive') {
    serveStatic(req, res, '/receive.html');
    return;
  }
  if (url.pathname === '/cast') {
    serveStatic(req, res, '/cast.html');
    return;
  }
  serveStatic(req, res, url.pathname);
}

/** 判断是否为本机（localhost）请求 */
function isLocalRequest(req) {
  const remote = req.socket.remoteAddress || '';
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

/* ---------------- 服务器创建 ---------------- */

const httpServer = http.createServer((req, res) => {
  // 手机等非本机访问 HTTP：无安全上下文，302 跳转到 HTTPS
  if (!isLocalRequest(req)) {
    const host = (req.headers.host || '').split(':')[0] || getLanIP();
    res.writeHead(302, { Location: `https://${host}:${PORT_HTTPS}${req.url}` });
    res.end();
    return;
  }
  requestHandler(req, res);
});

const httpsServer = https.createServer(ensureCert(), requestHandler);

/* ---------------- WebSocket 路由 ---------------- */

// 投屏码 WebRTC 信令（电脑端 ws://8080、手机端 wss://8081）
castCode.setupWebSocket(httpServer);
castCode.setupWebSocket(httpsServer);

// 无线投屏通道（ADB + scrcpy，仅挂在电脑端 HTTP 服务，localhost 访问）
setupWireless(httpServer);

// 兜底：不属于任何 WebSocket 服务的 upgrade 请求直接关闭，避免连接挂起
for (const server of [httpServer, httpsServer]) {
  server.on('upgrade', (req, socket) => {
    const pathname = (req.url || '').split('?')[0];
    if (pathname !== '/ws' && pathname !== '/wireless') socket.destroy();
  });
}

/* ---------------- 启动 ---------------- */

/** 找到占用指定端口的 PID 列表（netstat -ano 解析） */
function findPortPids(port) {
  try {
    const out = execSync('netstat -ano', { encoding: 'utf8', timeout: 5000 });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const m = line.trim().match(/^(?:TCP\s+\S+?:)(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
      if (m && Number(m[1]) === port) pids.add(Number(m[2]));
    }
    return [...pids];
  } catch { return []; }
}

/** 确认该 PID 是本项目的旧实例（命令行含 server/index.js 或 server/server.js），避免误杀无关 node 进程 */
function isOwnServerProcess(pid) {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`,
      { encoding: 'utf8', timeout: 8000 }
    );
    const cmd = String(out || '');
    return cmd.indexOf('server/index.js') !== -1
      || cmd.indexOf('server\\index.js') !== -1
      || cmd.indexOf('server/server.js') !== -1
      || cmd.indexOf('server\\server.js') !== -1;
  } catch { return false; }
}

function onListenError(port, label, server) {
  let retries = 0;
  return (err) => {
    // 端口被上次未正常关闭的 local-cast 实例占用：自动结束旧实例并重启（最多重试 3 次）。
    // 只结束「命令行确认是本项目入口」的进程，避免误伤无关 node 服务
    if (err && err.code === 'EADDRINUSE' && retries < 3) {
      retries++;
      const pids = findPortPids(port).filter((pid) => isOwnServerProcess(pid));
      if (pids.length) {
        console.error(` [自动修复] ${label}端口 ${port} 被上次未关闭的 local-cast 实例占用（PID ${pids.join(', ')}），正在结束并自动重启…`);
        for (const pid of pids) {
          try { execSync(`taskkill /T /F /PID ${pid}`, { stdio: 'ignore', timeout: 5000 }); } catch {}
        }
        setTimeout(() => { try { server.listen(port); } catch {} }, 1500);
        return;
      }
      // 另一个端口的处理可能正在结束旧实例：稍候重试一次
      setTimeout(() => { try { server.listen(port); } catch {} }, 1500);
      return;
    }
    if (err && err.code === 'EADDRINUSE') {
      console.error('==================================================');
      console.error(` [启动失败] ${label}端口 ${port} 已被占用，且自动修复未能接管。`);
      console.error(' 占用者可能不是本工具的进程，请手动关闭后重试，');
      console.error(' 或改用其他端口启动：set PORT_HTTP=8090 set PORT_HTTPS=8091 && npm start');
      console.error('==================================================');
      process.exit(1);
    }
    throw err;
  };
}

httpServer.on('error', onListenError(PORT_HTTP, 'HTTP ', httpServer));
httpsServer.on('error', onListenError(PORT_HTTPS, 'HTTPS ', httpsServer));

httpServer.listen(PORT_HTTP);
httpsServer.listen(PORT_HTTPS, () => {
  const lanIP = getLanIP();
  console.log('==================================================');
  console.log(' local-cast 投屏服务已启动');
  console.log(` 电脑端接收页: http://localhost:${PORT_HTTP}/`);
  console.log(' ├─ 扫码/投屏码通道：iOS 27+ Safari 可直投（首次访问需点「继续前往」）');
  console.log(' └─ 无线投屏通道（Android 推荐）：接收页右侧「无线投屏」面板，按提示配对即可');
  console.log(` 手机端投屏页: https://${lanIP}:${PORT_HTTPS}/cast （扫码或浏览器打开）`);
  console.log(' 提示：Android 浏览器均不支持网页屏幕采集（平台限制），请用无线投屏通道');
  console.log(' 按 Ctrl+C 停止服务');
  console.log('==================================================');
});

// 进程退出时清理会话，便于排查
process.on('SIGINT', () => {
  console.log('\n正在停止服务，清理会话...');
  for (const [code] of castCode.sessions) castCode.sessions.delete(code);
  httpServer.close();
  httpsServer.close(() => process.exit(0));
});

module.exports = { httpServer, httpsServer };
