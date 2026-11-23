/**
 * local-cast 信令服务
 *
 * 双端口设计（屏幕采集需要「安全上下文」，见 docs/01-技术方案.md）：
 *  - 8080 (HTTP)：电脑端接收页。localhost 被浏览器视为安全上下文，无需证书
 *  - 8081 (HTTPS)：手机端投屏页。getDisplayMedia 仅在 HTTPS 安全上下文可用，
 *    使用自签名证书（首次启动自动生成于 certs/ 目录），手机首次访问需点「继续前往」
 *
 * 职责：
 *  1. 提供电脑端接收页 / 手机端投屏页等静态资源；
 *  2. 生成 6 位投屏码，为电脑端生成二维码（PNG DataURL，页面零外部依赖）；
 *  3. 通过 WebSocket 匹配电脑端与手机端，转发 WebRTC 协商消息（SDP / ICE）。
 *
 * 媒体流走 WebRTC 点对点直连，不经过本服务。
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const forge = require('node-forge');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const { setupWireless } = require('./wireless');

const PORT_HTTP = Number(process.env.PORT_HTTP) || 8080;
const PORT_HTTPS = Number(process.env.PORT_HTTPS) || 8081;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const CERT_DIR = path.join(__dirname, '..', 'certs');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** 会话表：投屏码 -> { computer, phone, createdAt } */
const sessions = new Map();

/** 生成 6 位投屏码 */
function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/** 获取本机所有非内部 IPv4 地址（Wi-Fi、热点等所有可被外部访问的地址） */
function getLanIPs() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

/** 获取本机第一个非内部 IPv4 地址（默认主地址） */
function getLanIP() {
  const ips = getLanIPs();
  return ips.length ? ips[0] : '127.0.0.1';
}

/* ---------------- 自签名证书 ---------------- */

/**
 * 确保自签名证书存在且与当前本机地址匹配。
 * 本机地址变化时重新生成，避免手机端重复出现证书警告。
 */
function ensureCert() {
  const keyPath = path.join(CERT_DIR, 'key.pem');
  const certPath = path.join(CERT_DIR, 'cert.pem');
  const ipsPath = path.join(CERT_DIR, 'ips.json');
  const currentIPs = getLanIPs();

  let needGenerate = true;
  if (fs.existsSync(keyPath) && fs.existsSync(certPath) && fs.existsSync(ipsPath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(ipsPath, 'utf8'));
      needGenerate = (saved.ips || []).join(',') !== currentIPs.join(',');
    } catch {
      needGenerate = true;
    }
  }
  if (!needGenerate) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }

  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  const attrs = [{ name: 'commonName', value: 'local-cast' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  // SAN：localhost + 全部本机地址，尽量让浏览器少报证书错误
  const altNames = [{ type: 2, value: 'localhost' }];
  currentIPs.forEach((ip) => altNames.push({ type: 7, ip }));
  cert.setExtensions([{ name: 'subjectAltName', altNames }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(keyPath, forge.pki.privateKeyToPem(keys.privateKey));
  fs.writeFileSync(certPath, forge.pki.certificateToPem(cert));
  fs.writeFileSync(ipsPath, JSON.stringify({ ips: currentIPs, createdAt: Date.now() }));
  console.log('[证书] 已生成自签名证书（certs/ 目录），手机首次访问 HTTPS 需点「继续前往」');
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

/* ---------------- 公共工具 ---------------- */

function sendJSON(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function safeClose(ws) {
  if (ws && ws.readyState === ws.OPEN) ws.close();
}

/** 从会话中摘除某个连接，并广播对端状态 */
function detach(code, role) {
  const session = sessions.get(code);
  if (!session) return;
  session[role] = null;
  const peer = role === 'computer' ? 'phone' : 'computer';
  if (session[peer]) {
    sendJSON(session[peer], { type: 'peer-left', peer });
  }
  // 电脑端断开视为会话失效；仅手机端断开则保留会话，等待重新连接
  if (role === 'computer' && !session.phone) {
    sessions.delete(code);
  }
}

/* ---------------- HTTP 处理 ---------------- */

async function handleSessionRequest(req, res, url) {
  // 电脑端请求新的投屏码；可选指定 ip 参数用于指定二维码中的地址
  const lanIPs = getLanIPs();
  const wanted = url.searchParams.get('ip');
  const lanIP = lanIPs.includes(wanted) ? wanted : getLanIP();
  const code = generateCode();
  sessions.set(code, { computer: null, phone: null, createdAt: Date.now() });
  // 投屏链接必须为 HTTPS：getDisplayMedia 仅在安全上下文可用
  const castUrl = `https://${lanIP}:${PORT_HTTPS}/cast?code=${code}`;
  const qrDataUrl = await QRCode.toDataURL(castUrl, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 260,
    color: { dark: '#1f2430', light: '#ffffff' },
  });
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ code, qr: qrDataUrl, castUrl, lanIP, lanIPs, port: PORT_HTTPS }));
}

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
    handleSessionRequest(req, res, url).catch((err) => {
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

/* ---------------- WebSocket 信令部分 ---------------- */

function handleWsConnection(ws, req) {
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (msg.type) {
      case 'join': {
        const { role, code } = msg;
        if (!['computer', 'phone'].includes(role)) return;
        const session = sessions.get(code);
        if (!session) {
          sendJSON(ws, { type: 'error', message: '投屏码无效或已过期，请让电脑端重新打开页面获取新的投屏码' });
          ws.close();
          return;
        }
        // 连接复用保护：同角色重复加入时踢掉旧连接
        if (session[role]) {
          safeClose(session[role]);
        }
        session[role] = ws;
        sendJSON(ws, { type: 'joined', role, code });
        const peer = role === 'computer' ? 'phone' : 'computer';
        if (session[peer]) {
          // 两端就位，通知对端，手机端随后发起 WebRTC 协商
          sendJSON(session[peer], { type: 'peer-ready', peer: role });
          sendJSON(ws, { type: 'peer-ready', peer });
        } else {
          sendJSON(ws, { type: 'waiting', peer });
        }
        break;
      }
      case 'signal': {
        // WebRTC 协商消息转发：data 内含 sdp 或 candidate
        const { from, data } = msg;
        for (const [, session] of sessions) {
          if (session.computer && session.computer !== ws && from !== 'computer') {
            sendJSON(session.computer, { type: 'signal', from, data });
          } else if (session.phone && session.phone !== ws && from !== 'phone') {
            sendJSON(session.phone, { type: 'signal', from, data });
          }
        }
        break;
      }
      case 'leave': {
        for (const [code, session] of sessions) {
          if (session.computer === ws || session.phone === ws) {
            detach(code, session.computer === ws ? 'computer' : 'phone');
          }
        }
        break;
      }
      default:
        break;
    }
  });

  ws.on('close', () => {
    for (const [code, session] of sessions) {
      if (session.computer === ws) detach(code, 'computer');
      if (session.phone === ws) detach(code, 'phone');
    }
  });

  ws.on('error', (err) => {
    console.warn('[ws] 连接异常:', err.message);
  });
}

// 信令 WebSocket 同时挂在两个服务器上（电脑端 ws://8080、手机端 wss://8081）。
// 注意：ws 库的多个 WebSocketServer 挂同一 server 时，路径不匹配会直接 abort 握手，
// 因此统一使用 noServer 模式 + 自行按路径路由 upgrade 请求。
function setupWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', handleWsConnection);
  server.on('upgrade', (req, socket, head) => {
    const pathname = (req.url || '').split('?')[0];
    if (pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    }
  });
  return wss;
}
setupWebSocket(httpServer);
setupWebSocket(httpsServer);

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

function onListenError(port, label) {
  return (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error('==================================================');
      console.error(` [启动失败] ${label}端口 ${port} 已被占用。`);
      console.error(' 可能是上一次的服务仍在运行，请先关闭旧窗口，');
      console.error(' 或改用其他端口启动：set PORT_HTTP=8090 set PORT_HTTPS=8091 && npm start');
      console.error('==================================================');
      process.exit(1);
    }
    throw err;
  };
}

httpServer.on('error', onListenError(PORT_HTTP, 'HTTP '));
httpsServer.on('error', onListenError(PORT_HTTPS, 'HTTPS '));

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

// 进程退出时打印会话清理日志，便于排查
process.on('SIGINT', () => {
  console.log('\n正在停止服务，清理会话...');
  for (const [code] of sessions) sessions.delete(code);
  httpServer.close();
  httpsServer.close(() => process.exit(0));
});

module.exports = { httpServer, httpsServer, sessions, generateCode, getLanIP, getLanIPs };
