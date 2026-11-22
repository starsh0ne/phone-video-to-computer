/**
 * local-cast 信令服务
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
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

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

/** 生成 6 位投屏码（数字，去除易混淆字符思路：直接取 100000-999999 随机数） */
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

/* ---------------- HTTP 部分 ---------------- */

async function handleSessionRequest(req, res) {
  // 电脑端请求新的投屏码；可选指定 ip 参数用于指定二维码中的地址
  const lanIPs = getLanIPs();
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const wanted = url.searchParams.get('ip');
  const lanIP = lanIPs.includes(wanted) ? wanted : getLanIP();
  const code = generateCode();
  sessions.set(code, { computer: null, phone: null, createdAt: Date.now() });
  const castUrl = `http://${lanIP}:${PORT}/cast?code=${code}`;
  const qrDataUrl = await QRCode.toDataURL(castUrl, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 260,
    color: { dark: '#1f2430', light: '#ffffff' },
  });
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ code, qr: qrDataUrl, castUrl, lanIP, lanIPs, port: PORT }));
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/session' && req.method === 'GET') {
    handleSessionRequest(req, res).catch((err) => {
      console.error('[api/session] 生成会话失败:', err);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String(err && err.message || err) }));
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
});

/* ---------------- WebSocket 信令部分 ---------------- */

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
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
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error('==================================================');
    console.error(` [启动失败] 端口 ${PORT} 已被占用。`);
    console.error(' 可能是上一次的服务仍在运行，请先关闭旧窗口，');
    console.error(' 或改用其他端口启动：set PORT=8081 && npm start');
    console.error('==================================================');
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  const lanIP = getLanIP();
  console.log('==================================================');
  console.log(' local-cast 投屏服务已启动');
  console.log(` 电脑端接收页: http://localhost:${PORT}/`);
  console.log(` 手机端投屏页: http://${lanIP}:${PORT}/cast （手机扫码或浏览器打开）`);
  console.log(' 按 Ctrl+C 停止服务');
  console.log('==================================================');
});

// 进程退出时打印会话清理日志，便于排查
process.on('SIGINT', () => {
  console.log('\n正在停止服务，清理会话...');
  for (const [code] of sessions) sessions.delete(code);
  server.close(() => process.exit(0));
});

module.exports = { server, sessions, generateCode, getLanIP };
