/**
 * /wireless WebSocket 端点：连接管理、消息分发、停滞自愈触发、崩溃兜底。
 * 会话动作全部在 session.js，本文件只做「WebSocket ↔ 会话」的翻译层。
 */
'use strict';

const { WebSocketServer } = require('ws');
const logger = require('../logger');
const adbapi = require('../adb');
const connStore = require('../connection-store');
const { WirelessSession } = require('./session');
const {
  planStallRestart,
  RESTART_MIN_GAP_MS,
} = require('./stall-policy');

// 崩溃兑底：把未捕获异常/未处理的 Promise 拒绝落盘（此前服务进程曾静默退出，日志里零痕迹无法排查）
process.on('uncaughtException', (err) => {
  try { logger.error('[崩溃] 未捕获异常：' + (err && (err.stack || err.message) || err)); } catch {}
});
process.on('unhandledRejection', (reason) => {
  try { logger.error('[崩溃] 未处理的 Promise 拒绝：' + (reason && (reason.stack || reason.message || reason))); } catch {}
});

function setupWireless(httpServer) {
  const session = new WirelessSession();
  // 进程退出时恢复手机亮屏策略与唤醒（execSync 保证在 exit 事件里同步完成，否则会留下残留状态）
  process.on('exit', () => {
    if (session.keepAwakeOn && session.adbPath && session.serial) {
      try {
        require('child_process').execSync(`"${session.adbPath}" -s ${session.serial} shell svc power stayon false`, { stdio: 'ignore', timeout: 3000 });
      } catch {}
    }
    if (session.screenOffUsed && session.adbPath && session.serial) {
      try {
        require('child_process').execSync(`"${session.adbPath}" -s ${session.serial} shell input keyevent 224`, { stdio: 'ignore', timeout: 3000 });
      } catch {}
    }
  });
  // noServer 模式 + 自行路由：避免与 /ws 的 WebSocketServer 相互拒绝对方的 upgrade 请求
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws) => {
    session.clients.add(ws);
    if (session.state === 'streaming' && session.clients.size > 1) {
      // 多端同时接收是允许的，但要提醒：每个页面都在独立解码+跑看门狗，
      // 隐藏的旧标签页会成倍增加卡顿并触发多余的重启
      session.log('⚠ 检测到 ' + session.clients.size + ' 个页面同时接收投屏（可能是旧标签页）。多端同时解码会成倍增加卡顿，建议关闭多余的标签页只保留一个');
    }
    // 新客户端：先发当前状态；投屏中则补发关键帧缓存，保证立即出画面
    session.send(ws, { type: 'status', state: session.state, message: session.message });
    if (session.qrPair) {
      session.send(ws, { type: 'qr-pair-pending' });
    }
    if (session.state === 'streaming') {
      const boot = session.cache.bootstrap();
      if (boot && boot.length) ws.send(boot);
      // 补发缓存的 OpusHead 音频配置包（只随投屏开始广播一次，中途接入/刷新的客户端没有它就永远无声）
      if (session.lastAudioConfig && session.audioEnabled) {
        session.send(ws, session.lastAudioConfig);
      }
    }
    // v0.8.3 的自动 USB 连接已按用户要求移除：USB 连接改为手动点击「USB 连接」按钮发起
    const last = connStore.load();
    if (last && session.state === 'idle') {
      session.send(ws, { type: 'last-connection', addr: last.addr, savedAt: last.savedAt });
    }
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return; // 本端点只收 JSON 控制消息
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const reply = (err) => session.fail(err);
      switch (msg.type) {
        case 'status':
          session.send(ws, { type: 'status', state: session.state, message: session.message });
          break;
        case 'get-last-connection': {
          const l = connStore.load();
          session.send(ws, { type: 'last-connection', addr: l ? l.addr : '', savedAt: l ? l.savedAt : 0 });
          break;
        }
        case 'pair':
          session.pair(msg.addr, String(msg.code || '')).catch(reply);
          break;
        case 'qr-pair-start':
          session.startQrPairing().catch(reply);
          break;
        case 'qr-pair-cancel':
          session.cancelQrPairing();
          break;
        case 'connect':
          session.connect(msg.addr || '', msg.mode === 'usb' ? 'usb' : 'wireless').catch(reply);
          break;
        case 'connect-usb':
          // USB 直连：无需 IP/端口，无需同一网络，数据走数据线（v0.8.0）
          session.connectUsb().catch(reply);
          break;
        case 'start':
          session.stallTimes = []; // 手动重新开始投屏：重置降载阶梯（自动重启链路不清空，阶梯才能升级）
          session.start({
            bitrate: msg.bitrate,
            maxSize: msg.maxSize,
            maxFps: msg.maxFps,
            videoEncoder: msg.videoEncoder,
            screenOff: msg.screenOff === true, // v0.7.2 熄屏投屏（前端勾选）
          }).catch(reply);
          break;
        case 'ping':
          // 前端指标面板的 RTT 探测：原样回显时间戳
          session.send(ws, { type: 'pong', t: msg.t });
          break;
        case 'stop':
          session.stop('已手动停止').catch(reply);
          break;
        case 'video-stall': {
          // 前端看门狗②③：视频流停滞且手机仍在出声 → 走降载阶梯后自动重启采集会话。
          // 阶梯与熔断策略见 stall-policy.js（本处只做触发间隔与执行）
          if (session.state === 'streaming' && session.lastStartOptions) {
            const stallNow = Date.now();
            if (!session.lastVideoStallAt || stallNow - session.lastVideoStallAt > RESTART_MIN_GAP_MS) {
              session.lastVideoStallAt = stallNow;
              const plan = planStallRestart({
                stallTimes: session.stallTimes,
                options: session.lastStartOptions,
                now: stallNow,
              });
              session.stallTimes = plan.stallTimes;
              for (const text of plan.messages) session.log(text);
              if (plan.restart) {
                logger.info('[video-stall] 浏览器端检测到视频流停滞（手机仍在出声），自动重启采集会话');
                session.stop('视频流停滞，自动重启')
                  .then(() => session.start(plan.restartOpts))
                  .catch((e) => logger.error('[video-stall] 自动重启失败：' + e.message));
              } else {
                logger.info('[video-stall] 重启已达窗口上限，暂停自动重启');
              }
            }
          }
          break;
        }
        case 'client-log':
          // 前端音频诊断回报：落盘到文件日志，便于事后定位「无声」到底断在哪一环
          logger.info('[browser] ' + String(msg.message || '').slice(0, 300));
          break;
        default:
          break;
      }
    });
    ws.on('close', () => {
      session.clients.delete(ws);
    });
    ws.on('error', () => {
      session.clients.delete(ws);
    });
  });
  httpServer.on('upgrade', (req, socket, head) => {
    const pathname = (req.url || '').split('?')[0];
    if (pathname === '/wireless') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    }
  });
  return { wss, session };
}

module.exports = { setupWireless };
