/**
 * 投屏码会话（iOS 27+ Safari 网页直投通道的信令层）：
 *  - 电脑端 GET /api/session 获取 6 位投屏码 + 二维码；
 *  - 电脑端与手机端各自以 {type:'join', role, code} 加入同一会话；
 *  - WebRTC 协商消息（SDP / ICE）经本模块在两端间转发；
 *  - 媒体流走 WebRTC 点对点直连，不经过本服务。
 */
'use strict';

const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');
const { PORT_HTTPS, getLanIP, getLanIPs } = require('./config');

/** 会话表：投屏码 -> { computer, phone, createdAt } */
const sessions = new Map();

/** 生成 6 位投屏码 */
function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
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

/* ---------------- HTTP：申请投屏码 ---------------- */

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

/* ---------------- WebSocket：join / signal / leave ---------------- */

function handleWsConnection(ws) {
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

module.exports = { sessions, generateCode, handleSessionRequest, setupWebSocket };
