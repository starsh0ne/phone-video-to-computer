/**
 * 无线投屏通道：ADB（无线调试）+ scrcpy-server 采集手机屏幕 → H.264 裸流 → WebSocket → 电脑端 WebCodecs 解码
 *
 * 与网页直投通道（cast.html）并存：
 *  - Android 所有浏览器均不支持 getDisplayMedia（平台限制），本通道不经浏览器、直接由 scrcpy-server 采集；
 *  - iOS 27+ Safari 仍可用网页直投通道。
 *
 * WebSocket 端点：/wireless（挂在电脑端 HTTP 服务，localhost 访问）
 *  - 客户端 → 服务端（JSON）：{type:'pair'|'qr-pair-start'|'qr-pair-cancel'|'connect'|'start'|'stop'|'status', ...}
 *  - 服务端 → 客户端（JSON）：{type:'status'|'log'|'error'|'qr-pair', ...}
 *  - 服务端 → 客户端（二进制）：H.264 Annex-B 裸流分片
 *
 * 二维码配对（AOSP adb_wifi 协议）：
 *  电脑生成 `WIFI:T:ADB;S:studio-XXXX;P:密码;;` 二维码 → 手机相机扫码后以指定服务名启动配对服务
 *  → 电脑通过 adb mdns services 发现该服务 → adb pair <ip:port> <密码> → 自动连接。
 */
'use strict';

const net = require('net');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const tools = require('./tools');
const adbapi = require('./adb');
const logger = require('./logger');
const connStore = require('./connection-store');

const SCRCPY_REMOTE_PATH = '/data/local/tmp/scrcpy-server';

/**
 * H.264 Annex-B 关键帧缓存：
 * 保留 SPS/PPS 与最近一个 IDR 起始的全部数据，新加入的页面先收缓存再收实时流，
 * 无需等待下一个 GOP（scrcpy 默认关键帧间隔约 10s）。
 */
class KeyframeCache {
  constructor(limit = 32 * 1024 * 1024) {
    this.limit = limit;
    this.reset();
  }

  reset() {
    this.buffer = Buffer.alloc(0);   // 最近 IDR 起的全部数据（含起始码）
    this.sps = Buffer.alloc(0);      // 最近一次 SPS NAL（含起始码）
    this.pps = Buffer.alloc(0);      // 最近一次 PPS NAL（含起始码）
    this.scanFrom = 0;               // 已扫描到的位置（保留少量回溯窗口）
    this.keyframeSeen = false;
  }

  /** 在 buf 中从 from 开始找下一个起始码（00 00 01）位置，找不到返回 -1 */
  static findStartCode(buf, from) {
    const end = buf.length - 2;
    for (let i = from; i < end; i++) {
      if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) return i;
    }
    return -1;
  }

  /** 喂入一段流数据 */
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.scan();

    // 容量保护：超限时只保留最近数据（极端情况丢失引导能力，前端等下一个 IDR 即可）
    if (this.buffer.length > this.limit) {
      this.buffer = this.buffer.slice(-Math.floor(this.limit / 2));
      this.scanFrom = 0;
      this.scan();
    }
  }

  /** 扫描未处理区域，记录 SPS/PPS 与最新 IDR 位置 */
  scan() {
    const buf = this.buffer;
    // 回溯 4 字节，避免跨 chunk 的起始码被漏掉
    let i = Math.max(0, this.scanFrom - 4);
    let idrPos = -1;
    while (i < buf.length - 3) {
      if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
        const hdr = i + 3;
        if (hdr < buf.length) {
          const type = buf[hdr] & 0x1f;
          const next = KeyframeCache.findStartCode(buf, hdr);
          const nalEnd = next === -1 ? buf.length : next;
          if (type === 7) {
            this.sps = buf.slice(i, nalEnd);
          } else if (type === 8) {
            this.pps = buf.slice(i, nalEnd);
          } else if (type === 5) {
            idrPos = i;
            this.keyframeSeen = true;
          }
        }
        i = hdr;
      } else {
        i++;
      }
    }
    this.scanFrom = buf.length;
    // 出现新的 IDR：缓存从该关键帧重新开始
    if (idrPos > 0) {
      this.buffer = this.buffer.slice(idrPos);
      this.scanFrom -= idrPos;
    } else if (idrPos === 0) {
      this.scanFrom = buf.length;
    }
  }

  /** 新客户端加入时发送的引导数据（SPS+PPS+最近 IDR 起的流） */
  bootstrap() {
    if (!this.keyframeSeen) return Buffer.alloc(0);
    const parts = [];
    if (this.sps.length) parts.push(this.sps);
    if (this.pps.length) parts.push(this.pps);
    parts.push(this.buffer);
    return Buffer.concat(parts);
  }
}

/** 生成二维码配对密钥材料：服务实例名 + 配对密码（纯字母数字，规避 WIFI: 串转义问题） */
function generateQrPairingSecrets() {
  const alnum = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const pick = (n) => Array.from(crypto.randomBytes(n))
    .map((b) => alnum[b % alnum.length]).join('');
  const instance = 'studio-' + pick(10);
  const password = pick(20);
  return { instance, password, qrString: `WIFI:T:ADB;S:${instance};P:${password};;` };
}

/**
 * scrcpy v3+ 流解析器（send_stream_meta=true + send_frame_meta=true 的线格式）：
 *   [4 字节编码器 id（大端）]  之后为若干帧：
 *   - 会话元数据（首 8 字节最高位为 1）：12 字节 flags+width+height，跳过
 *   - 普通帧：[8 字节 PTS+标志（大端）][4 字节包长（大端）][载荷]
 *     bit62=配置包（视频 CSD / 音频 OpusHead），bit61=关键帧
 * 音频流特例：首 4 字节若为 0x00000000 表示设备禁用音频（继续仅视频），
 * 0x00000001 表示配置错误（服务端会退出）。
 */
class ScrcpyStreamReader {
  constructor({ onHeader, onPacket } = {}) {
    this.onHeader = onHeader || (() => {});
    this.onPacket = onPacket || (() => {});
    this.headerSeen = false;
    this.buf = null;
  }

  push(chunk) {
    this.buf = this.buf ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf && this.buf.length) {
      if (!this.headerSeen) {
        if (this.buf.length < 4) return;
        const id = this.buf.readUInt32BE(0);
        this.buf = this.buf.subarray(4);
        this.headerSeen = true;
        this.onHeader(id);
        continue;
      }
      if (this.buf.length < 12) return;
      const ptsFlags = this.buf.readBigUInt64BE(0);
      const size = this.buf.readUInt32BE(8);
      if ((ptsFlags >> 63n) & 1n) {
        // 会话元数据（分辨率等）：整体 12 字节，跳过
        this.buf = this.buf.subarray(12);
        continue;
      }
      if (this.buf.length < 12 + size) return;
      const payload = Buffer.from(this.buf.subarray(12, 12 + size));
      this.buf = this.buf.length === 12 + size ? null : this.buf.subarray(12 + size);
      this.onPacket({
        pts: Number(ptsFlags & 0x1fffffffffffffffn),
        config: ((ptsFlags >> 62n) & 1n) === 1n,
        keyFrame: ((ptsFlags >> 61n) & 1n) === 1n,
        payload,
      });
    }
  }
}

/* 常量：scrcpy 编码器 id（4 字节 ASCII） */
const CODEC_H264 = 0x68323634;      // 'h264'
const CODEC_OPUS = 0x6f707573;      // 'opus'
const STREAM_DISABLE = 0x00000000;  // 设备禁用该流（如 Android <11 无法采集音频）
const STREAM_ERROR = 0x00000001;    // 配置错误

/** 无线投屏会话（单例：同一时间只允许一路无线投屏） */
class WirelessSession {
  constructor() {
    this.clients = new Set();
    this.state = 'idle'; // idle | pairing | connecting | ready | streaming
    this.message = '未连接';
    this.adbPath = null;
    this.serial = null;       // 已连接设备的 serial（ip:port 或 mDNS 服务名）
    this.cache = new KeyframeCache();
    this.videoSocket = null;
    this.serverProc = null;
    this.forwardPort = null;
    this.stats = { bytes: 0, startedAt: 0 };
    this.qrPair = null;       // 进行中的二维码配对 { instance, password, timer, deadline }
    this.audioSocket = null;  // 音频 socket（scrcpy opus 通道）
    this.audioEnabled = false;
    this.audioMediaTotal = 0;     // 真实音频媒体包总数（不含配置包）
    this.audioWindow = { packets: 0, bytes: 0 }; // 20s 流量统计窗口
    this.audioStatsTimer = null; // 周期性音频流量日志
    this.lastAudioConfig = null; // 缓存的 OpusHead 配置帧（新客户端接入补发）
  }

  broadcast(obj) {
    const raw = JSON.stringify(obj);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(raw);
    }
  }

  send(ws, obj) {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  broadcastBinary(buf) {
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(buf);
    }
  }

  /**
   * 广播音频包：1 字节类型前缀（'C'=OpusHead 配置包，'P'=Opus 音频包）+ 载荷，
   * 与视频二进制帧区分（视频无前缀，前端按 ArrayBuffer 直接进 H.264 解析器）
   */
  broadcastBinaryAudio(payload, isConfig) {
    const frame = Buffer.allocUnsafe(1 + payload.length);
    frame[0] = isConfig ? 0x43 : 0x50; // 'C' / 'P'
    payload.copy(frame, 1);
    if (isConfig) this.lastAudioConfig = frame; // 缓存配置帧：中途接入/刷新的客户端补发，否则永远无声
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(frame);
    }
  }

  /** 广播错误（附当前状态，便于前端恢复按钮）；同时落盘到文件日志 */
  fail(message) {
    const text = String(message && message.message ? message.message : message);
    logger.error('[fail] ' + text + '（state=' + this.state + '）');
    this.broadcast({ type: 'error', message: text, state: this.state });
  }

  log(message) {
    logger.info(String(message));
    this.broadcast({ type: 'log', message });
  }

  setState(state, message) {
    this.state = state;
    this.message = message;
    logger.info(`[状态] ${state} · ${message}`);
    this.broadcast({ type: 'status', state, message });
  }

  /** scrcpy 启动失败时抓取手机端 logcat 摘要（Java 崩溃栈在 AndroidRuntime 标签下） */
  async dumpLogcat() {
    const adbPath = this.adbPath;
    const serial = this.serial;
    if (!adbPath || !serial) return;
    try {
      const { stdout } = await adbapi.adb(adbPath, ['-s', serial, 'shell', 'logcat', '-d', '-t', '400'], 15000);
      const lines = (stdout || '').split(/\r?\n/).filter((l) => /scrcpy|AndroidRuntime|FATAL/i.test(l));
      const tail = lines.slice(-40);
      logger.error('[logcat 崩溃摘要]\n' + (tail.join('\n') || '（无 scrcpy/AndroidRuntime 相关条目）'));
      this.log('[logcat] 已抓取手机端日志摘要，详见 logs/localcast.log');
    } catch (err) {
      logger.error('[logcat] 抓取失败：' + (err.message || err));
    }
  }

  async ensureAdb() {
    if (!this.adbPath) {
      this.log('正在准备 adb 工具链…');
      const { adbPath } = await tools.ensureAdb((m) => this.log(m));
      this.adbPath = adbPath;
      this.log('adb 就绪：' + adbPath);
    }
    return this.adbPath;
  }

  /* ---------- 配对（配对码方式） ---------- */
  async pair(addr, code) {
    if (this.state === 'streaming') throw new Error('投屏中，请先停止当前投屏');
    try {
      this.setState('pairing', '正在配对（请保持手机配对弹窗打开）…');
      const adbPath = await this.ensureAdb();
      const out = await adbapi.pair(adbPath, addr, code, {
        onLine: (line) => this.log('[adb] ' + line),
      });
      this.log(out);
      this.setState('ready', '配对成功，正在自动连接设备…');
      // adb 配对成功后会自动连接；轮询几次确保拿到设备
      const ok = await this.tryAutoConnect(5);
      if (!ok) {
        this.setState('ready', '配对成功。请查看手机「无线调试」主界面的 IP:端口，填入连接地址后点击「连接」');
      }
    } catch (err) {
      // 已配对过的设备直接尝试连接
      if (/already paired|已经配对/i.test(String(err.message))) {
        this.log('设备此前已配对，尝试直接连接…');
        const ok = await this.tryAutoConnect(5).catch(() => false);
        if (ok) return;
      }
      this.setState('idle', '配对失败');
      throw err;
    }
  }

  /* ---------- 配对（二维码方式） ---------- */
  async startQrPairing() {
    if (this.state === 'streaming') throw new Error('投屏中，请先停止当前投屏');
    if (this.qrPair) return; // 已在进行中
    const adbPath = await this.ensureAdb();

    const { instance, password, qrString } = generateQrPairingSecrets();
    const qrDataUrl = await QRCode.toDataURL(qrString, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 220,
      color: { dark: '#1f2430', light: '#ffffff' },
    });
    const deadline = Date.now() + 120000; // 2 分钟有效
    const qrPair = { instance, password, timer: null, deadline };
    this.qrPair = qrPair;

    this.broadcast({ type: 'qr-pair', qr: qrDataUrl, instance });
    this.setState('pairing', '请用手机相机扫描二维码，并按手机提示开始配对…');

    const poll = async () => {
      if (this.qrPair !== qrPair) return; // 已取消或被替换
      if (Date.now() > deadline) {
        this.cancelQrPairing('二维码配对超时，请重试');
        return;
      }
      try {
        const services = await adbapi.mdnsServicesDetailed(adbPath);
        const target = services.find((s) => s.name === instance && /_adb-tls-pairing/.test(s.type));
        if (target) {
          this.log(`已发现手机配对服务：${target.addr}`);
          this.qrPair = null;
          clearTimeout(qrPair.timer);
          try {
            const out = await adbapi.pair(adbPath, target.addr, password, {
              onLine: (line) => this.log('[adb] ' + line),
            });
            this.log(out);
          } catch (err) {
            this.setState('idle', '二维码配对失败');
            this.fail(err);
            return;
          }
          this.setState('ready', '配对成功，正在自动连接设备…');
          const ok = await this.tryAutoConnect(5);
          if (!ok) {
            this.setState('ready', '配对成功。请查看手机「无线调试」主界面的 IP:端口，填入连接地址后点击「连接」');
          }
          return;
        }
      } catch (err) {
        this.log('mDNS 发现异常：' + (err.message || err));
      }
      qrPair.timer = setTimeout(poll, 1500);
    };
    qrPair.timer = setTimeout(poll, 1500);
  }

  cancelQrPairing(reason = '已取消二维码配对') {
    if (!this.qrPair) return;
    clearTimeout(this.qrPair.timer);
    this.qrPair = null;
    this.broadcast({ type: 'qr-pair-cancel' });
    this.setState('idle', reason);
  }

  /* ---------- 连接 ---------- */
  async connect(addr) {
    if (this.state === 'streaming') throw new Error('投屏中，请先停止当前投屏');
    try {
      this.setState('connecting', '正在连接手机…');
      const adbPath = await this.ensureAdb();
      if (!addr) {
        const ok = await this.tryAutoConnect();
        if (!ok) throw new Error('未能自动发现设备，请手动输入连接地址');
        return;
      }
      this.serial = await adbapi.connect(adbPath, addr);
      connStore.save(addr); // 只记住最近一次成功地址（覆盖式，旧端口不残留）
      this.setState('ready', '已连接：' + this.serial + '，可以开始投屏');
    } catch (err) {
      // 缓存地址失效（无线调试重启后端口会变）→ 自动用 mDNS 发现当前可用地址，免去手动重输
      if (addr) {
        this.log('地址 ' + addr + ' 连接失败（' + (err.message || err) + '），自动发现当前地址…');
        try {
          if (await this.tryAutoConnect(2)) return;
        } catch { /* 发现也失败：抛出原错误 */ }
      }
      this.setState('idle', '连接失败');
      throw err;
    }
  }

  /** 通过 mDNS / 已连接设备自动发现并连接；postPair 时轮询多次（配对后 adb 自动连接需要几秒） */
  async tryAutoConnect(attempts = 1) {
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 1500));
      try {
        const adbPath = this.adbPath;
        // 1. mDNS 发现无线调试服务
        const services = await adbapi.mdnsServicesDetailed(adbPath);
        for (const s of services) {
          if (/_adb-tls-connect/.test(s.type)) {
            try {
              this.serial = await adbapi.connect(adbPath, s.addr);
              connStore.save(s.addr); // 记住自动发现的成功地址
              this.setState('ready', '已连接：' + this.serial + '，可以开始投屏');
              return true;
            } catch { /* 尝试下一个 */ }
          }
        }
        // 2. adb devices 里已就绪的无线设备（ip:port 或 mDNS 服务名）——先探活再采信：
        //    断开的旧传输可能在列表里残留「device」状态，直接采信会把失效端口写入缓存（v0.6.6）
        const list = await adbapi.devices(adbPath);
        const wirelessList = list.filter((s) => adbapi.isWirelessSerial(s));
        for (const s of wirelessList) {
          const alive = await adbapi.shell(adbPath, s, 'echo ok').catch(() => false);
          if (!alive) continue;
          this.serial = s;
          if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(s)) {
            connStore.save(s); // 覆盖保存，纠正任何旧端口残留
          }
          this.setState('ready', '已连接：' + s + '，可以开始投屏');
          return true;
        }
      } catch (err) {
        this.log('自动发现失败：' + (err.message || err));
      }
    }
    return false;
  }

  /* ---------- 开始投屏 ---------- */
  async start(options = {}) {
    this.lastStartOptions = { ...options }; // video-stall 看门狗自动重启时复用
    if (this.state === 'streaming') throw new Error('已在投屏中');
    try {
      this.setState('connecting', '正在准备投屏…');
      const adbPath = await this.ensureAdb();

      if (!this.serial) {
        const ok = await this.tryAutoConnect();
        if (!ok) throw new Error('尚未连接手机：请先配对并连接');
      }
      const serial = this.serial;

      this.setState('connecting', '正在获取 scrcpy-server…');
      const serverJar = await tools.ensureScrcpyServer((m) => this.log(m));

      this.setState('connecting', '正在推送 scrcpy-server 到手机…');
      await adbapi.push(adbPath, serial, serverJar, SCRCPY_REMOTE_PATH);

      this.setState('connecting', '正在建立端口转发…');
      this.forwardPort = await adbapi.forward(adbPath, serial, 0, 'scrcpy');

      this.setState('connecting', '正在启动屏幕采集…');
      this.cache.reset();
      const wantAudio = options.audio !== false;
      this.serverProc = adbapi.startScrcpyServer(adbPath, serial, tools.SCRCPY_VERSION, {
        bitrate: options.bitrate,
        maxSize: options.maxSize,
        maxFps: options.maxFps,
        audio: wantAudio,
        remotePath: SCRCPY_REMOTE_PATH,
      });
      logger.info('[scrcpy 启动命令] ' + this.serverProc.cmd);
      // v0.6.5：投屏期间保持手机亮屏（svc power stayon）——熄屏后画面采集停摆、音频退化为静音包，
      // 正是日志里反复出现的停摆形态（熄屏超时 ~2 分钟与停摆间隔吻合）；stop() / 进程退出时恢复
      try {
        await adbapi.shell(adbPath, serial, 'svc power stayon true');
        this.keepAwakeOn = true;
        this.log('已保持手机亮屏（投屏期间，停止后自动恢复）');
      } catch {}
      // 实际开流的地址覆盖缓存：无论哪个路径之前写入了旧值，都用真正在流的地址纠偏（v0.6.6）
      if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(this.serial)) {
        connStore.save(this.serial);
      }
      // 服务端日志转发给页面（排查问题用，stdout/stderr 全量逐行）
      const pipeLog = (d) => {
        for (const line of d.toString().split(/\r?\n/)) {
          const t = line.trim();
          if (t) this.log('[scrcpy] ' + t.slice(0, 200));
        }
      };
      this.serverProc.child.stdout.on('data', pipeLog);
      this.serverProc.child.stderr.on('data', pipeLog);
      this.serverProc.child.on('close', (code) => {
        if (this.state === 'streaming' && this.serverProc) {
          this.log(`scrcpy-server 已退出（code=${code}）`);
          this.stop('采集服务已退出');
        } else if (this.state === 'connecting') {
          // 启动阶段即退出（如 CLASSPATH/版本不匹配、设备断开）：置空让视频通道重试立即失败
          this.log(`scrcpy-server 启动阶段退出（code=${code}），中止连接重试`);
          logger.error(`[scrcpy] 启动阶段退出 code=${code}；完整命令：${this.serverProc ? this.serverProc.cmd : '(已清理)'}`);
          this.serverProc = null;
          this.dumpLogcat(); // 异步抓取手机端崩溃栈，不阻塞流程
        }
      });

      // 连接视频/音频 socket，读取 scrcpy 流。
      // 注意四点（均来自 adb forward 与 scrcpy tunnel_forward 的真实行为）：
      // 1) scrcpy tunnel_forward 模式下服务端按 video → audio 顺序各接受一次连接（本端发起）。
      // 2) adb forward 的本地端口在设备端 socket 就绪之前也会接受本地 TCP 连接，
      //    随后发现远端连不上就立刻关闭这条连接。因此「本地 connect 成功」不代表通道可用，
      //    必须等到收到首个数据才视为通道建立；在那之前连接被关闭就静默重试。
      // 3) 关键时序：服务端要等两条 socket 都 accept 完才开始启动编码器、视频流才会出数据。
      //    若「等视频出数据才连音频」会死锁。因此启用 send_dummy_byte：服务端接受视频
      //    socket 后立即写 1 字节哑字节（先于音频 accept），用该字节确认视频通道，随后再连音频。
      // 4) 音频 socket 不连接，服务端会一直阻塞在 accept() 上，投屏不会开始。
      this.stats = { bytes: 0, startedAt: Date.now() };
      const openStream = (label, onData) => new Promise((resolve, reject) => {
        const deadline = Date.now() + 20000;
        const attempt = () => {
          if (!this.serverProc) { reject(new Error('scrcpy-server 启动失败或已退出')); return; }
          const sock = net.connect(this.forwardPort, '127.0.0.1');
          let gotData = false;   // 已收到数据 → 通道确认建立，不再重试
          let retried = false;   // 本轮重试防重入（error/close 可能连续触发）
          const retry = (why) => {
            if (gotData || retried) return;
            retried = true;
            sock.destroy();
            if (Date.now() > deadline) reject(new Error(`${label}通道连接超时（${why}）`));
            else setTimeout(attempt, 300);
          };
          sock.once('error', (err) => retry(err.message));
          sock.once('close', () => retry('连接被关闭'));
          sock.on('data', (chunk) => {
            if (!gotData) {
              gotData = true;
              resolve(sock);
            }
            onData(chunk);
          });
        };
        attempt();
      });

      // --- 视频 socket：解析帧头，剥出 H.264 裸流转发（首个字节是哑字节，跳过）---
      const buffered = [];   // 状态切换为 streaming 之前缓冲视频数据
      let live = false;
      let dummySkipped = false;
      const videoReader = new ScrcpyStreamReader({
        onHeader: (id) => {
          if (id === CODEC_H264) return;
          if (id === STREAM_DISABLE || id === STREAM_ERROR) {
            this.log('视频流被设备禁用或出错（codec id=0x' + id.toString(16) + '）');
          } else {
            this.log('非 H.264 视频流（codec id=0x' + id.toString(16) + '），尝试按 H.264 解码');
          }
        },
        onPacket: (pkt) => {
          // H.264 Annex-B 裸流：SPS/PPS 在带内，直接整包转发（配置包即 SPS/PPS，同带内）
          if (!live) buffered.push(pkt.payload);
          else {
            this.stats.bytes += pkt.payload.length;
            this.cache.push(pkt.payload);
            this.broadcastBinary(pkt.payload);
          }
        },
      });
      const videoSocket = await openStream('视频', (chunk) => {
        let buf = chunk;
        if (!dummySkipped) {
          dummySkipped = true;
          buf = chunk.subarray(1); // 跳过哑字节（send_dummy_byte=true 时视频 socket 的第 1 字节）
          if (!buf.length) return;
        }
        videoReader.push(buf);
      });
      this.videoSocket = videoSocket;
      videoSocket.once('close', () => {
        if (this.state === 'streaming') this.stop('视频通道已断开');
      });
      videoSocket.once('error', () => {
        if (this.state === 'streaming') this.stop('视频通道断开');
      });

      // --- 音频 socket：解析帧头，提取 Opus 包转发（开启音频时才有第二条 socket）---
      this.audioSocket = null;
      this.audioEnabled = false;
      if (wantAudio) {
        const audioReader = new ScrcpyStreamReader({
          onHeader: (id) => {
            if (id === CODEC_OPUS) {
              this.audioEnabled = true;
              this.broadcast({ type: 'audio', enabled: true, codec: 'opus' });
              this.log('音频通道已建立（Opus）');
              // 每 20s 记录一次真实音频流量到文件日志（区分「手机没发」与「发了但听不到」）
              clearInterval(this.audioStatsTimer);
              this.audioStatsTimer = setInterval(() => {
                if (!this.audioEnabled || this.state !== 'streaming') return;
                const kbps = Math.round(this.audioWindow.bytes * 8 / 20 / 1000);
                logger.info('[audio] 流量(20s)：' + this.audioWindow.packets + ' 个媒体包 ' +
                  (this.audioWindow.bytes / 1024).toFixed(1) + 'KB ≈' + kbps + 'kbps');
                this.audioWindow.packets = 0;
                this.audioWindow.bytes = 0;
              }, 20000);
            } else if (id === STREAM_DISABLE) {
              // 设备无法采集音频（如 Android <11）：服务端写 0 后继续仅视频
              this.log('手机系统不支持音频采集（需 Android 11+），本次仅投屏画面');
              this.broadcast({ type: 'audio', enabled: false, reason: 'device' });
            } else if (id === STREAM_ERROR) {
              this.log('音频配置出错，本次仅投屏画面');
              this.broadcast({ type: 'audio', enabled: false, reason: 'error' });
            } else {
              this.log('未知音频编码（id=0x' + id.toString(16) + '），忽略音频');
              this.broadcast({ type: 'audio', enabled: false, reason: 'codec' });
            }
          },
          onPacket: (pkt) => {
            if (!this.audioEnabled) return;
            if (pkt.config) {
              logger.info('[audio] 收到配置包 OpusHead（' + pkt.payload.length + ' 字节），已广播');
            } else {
              this.audioMediaTotal++;
              this.audioWindow.packets++;
              this.audioWindow.bytes += pkt.payload.length;
              if (this.audioMediaTotal === 1) {
                logger.info('[audio] 首个真实音频媒体包已到达（区别于配置包）');
              }
            }
            this.broadcastBinaryAudio(pkt.payload, pkt.config);
          },
        });
        let audioSock;
        try {
          audioSock = await openStream('音频', (chunk) => audioReader.push(chunk));
        } catch (err) {
          this.log('音频通道建立失败，继续仅视频投屏：' + err.message);
          logger.error('[audio] 通道建立失败：' + err.message);
        }
        if (audioSock) {
          this.audioSocket = audioSock;
          // 音频 socket 断开不终止投屏（视频继续）
          audioSock.once('close', () => {
            if (this.audioEnabled) {
              this.log('音频通道已断开（画面不受影响）');
              this.audioEnabled = false;
              this.broadcast({ type: 'audio', enabled: false, reason: 'closed' });
            }
          });
          audioSock.once('error', () => {});
        }
      }

      this.setState('streaming', '投屏中 · ' + serial + (this.audioEnabled ? '（含声音）' : ''));
      // 状态推送完成后再投递建立期间缓冲的视频数据，保证前端先进入 streaming 再收到码流
      live = true;
      for (const chunk of buffered) {
        this.stats.bytes += chunk.length;
        this.cache.push(chunk);
        this.broadcastBinary(chunk);
      }
      buffered.length = 0;
    } catch (err) {
      await this.stop('启动失败');
      throw err;
    }
  }

  /* ---------- 停止 ---------- */
  async stop(reason = '已停止') {
    if (this.qrPair) this.cancelQrPairing();
    if (this.videoSocket) {
      try { this.videoSocket.destroy(); } catch {}
      this.videoSocket = null;
    }
    if (this.audioSocket) {
      try { this.audioSocket.destroy(); } catch {}
      this.audioSocket = null;
    }
    this.audioEnabled = false;
    clearInterval(this.audioStatsTimer);
    this.audioStatsTimer = null;
    this.audioMediaTotal = 0;
    this.audioWindow = { packets: 0, bytes: 0 };
    this.lastAudioConfig = null;
    if (this.serverProc) {
      this.serverProc.stop();
      this.serverProc = null;
    }
    if (this.keepAwakeOn) {
      // 恢复手机屏幕超时策略（正常停止路径；Ctrl+C 走 process exit 的同步兑底）
      this.keepAwakeOn = false;
      try {
        await adbapi.shell(this.adbPath, this.serial, 'svc power stayon false');
        this.log('已恢复手机屏幕超时策略');
      } catch {}
    }
    if (this.adbPath && this.serial && this.forwardPort) {
      await adbapi.removeForward(this.adbPath, this.serial, this.forwardPort).catch(() => {});
    }
    this.forwardPort = null;
    this.cache.reset();
    this.setState('idle', reason);
  }
}

/* ---------------- WebSocket 端点 ---------------- */

function setupWireless(httpServer) {
  const session = new WirelessSession();
  // 进程退出时恢复手机亮屏策略（execSync 保证在 exit 事件里同步完成，否则会留下「屏幕常亮」的残留设置）
  process.on('exit', () => {
    if (session.keepAwakeOn && session.adbPath && session.serial) {
      try {
        require('child_process').execSync(`"${session.adbPath}" -s ${session.serial} shell svc power stayon false`, { stdio: 'ignore', timeout: 3000 });
      } catch {}
    }
  });
  // noServer 模式 + 自行路由：避免与 /ws 的 WebSocketServer 相互拒绝对方的 upgrade 请求
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws) => {
    session.clients.add(ws);
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
    // 下发上次成功连接的地址（前端自动回填输入框并尝试自动连接）
    const last = connStore.load();
    if (last && session.state === 'idle') {
      session.send(ws, { type: 'last-connection', addr: last.addr, savedAt: last.savedAt });
    }
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
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
          session.connect(msg.addr || '').catch(reply);
          break;
        case 'start':
          session.start({ bitrate: msg.bitrate, maxSize: msg.maxSize, maxFps: msg.maxFps }).catch(reply);
          break;
        case 'stop':
          session.stop('已手动停止').catch(reply);
          break;
        case 'video-stall':
          // 前端看门狗②：音频正常但视频流长期无数据（手机端编码器停摆）→ 自动重启采集会话（30s 只重启一次）
          if (session.state === 'streaming' && session.lastStartOptions) {
            const stallNow = Date.now();
            if (!session.lastVideoStallAt || stallNow - session.lastVideoStallAt > 30000) {
              session.lastVideoStallAt = stallNow;
              // v0.6.5 自适应降载：5 分钟内反复停滞说明手机编码器负载过高（高码率+高帧率）→
              // 每次降 25% 码率（下限 6Mbps），减少停摆复发；手动重新开始投屏则恢复所选画质档
              session.stallTimes = (session.stallTimes || []).filter((t) => stallNow - t < 300000);
              session.stallTimes.push(stallNow);
              const restartOpts = { ...session.lastStartOptions };
              if (session.stallTimes.length >= 2 && restartOpts.bitrate && restartOpts.bitrate > 6000000) {
                restartOpts.bitrate = Math.max(6000000, Math.floor(restartOpts.bitrate * 0.75));
                session.lastStartOptions = restartOpts;
                logger.info('[video-stall] 5 分钟内第 ' + session.stallTimes.length + ' 次停滞，自适应降码率至 ' + (restartOpts.bitrate / 1e6).toFixed(1) + 'Mbps');
                session.log('⚠ 视频流频繁停滞，已自动降低码率至 ' + (restartOpts.bitrate / 1e6).toFixed(1) + ' Mbps（停止后重选画质档可恢复）');
              }
              logger.info('[video-stall] 浏览器端检测到视频流停滞（音频正常），自动重启采集会话');
              session.stop('视频流停滞，自动重启')
                .then(() => session.start(restartOpts))
                .catch((e) => logger.error('[video-stall] 自动重启失败：' + e.message));
            }
          }
          break;
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

module.exports = { setupWireless, WirelessSession, KeyframeCache, ScrcpyStreamReader, generateQrPairingSecrets, CODEC_H264, CODEC_OPUS, STREAM_DISABLE, STREAM_ERROR };
