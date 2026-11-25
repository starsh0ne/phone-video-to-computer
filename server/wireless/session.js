/**
 * 无线投屏会话状态机（单例：同一时间只允许一路无线投屏）。
 *
 * 生命周期：idle → pairing/connecting → ready → streaming → idle。
 * 职责：设备连接（显式地址 + mDNS 自动发现 + 缓存纠偏）、scrcpy-server 推送与启动、
 *       视频/音频双 socket 建立与数据广播、停滞自愈触发、亮屏保持、投屏码配对。
 * 消息路由由 ws-endpoint.js 完成，本模块只对外提供动作方法与广播通道。
 */
'use strict';

const net = require('net');
const QRCode = require('qrcode');
const tools = require('../tools');
const adbapi = require('../adb');
const logger = require('../logger');
const connStore = require('../connection-store');
const { KeyframeCache } = require('./keyframe-cache');
const { generateQrPairingSecrets } = require('./pairing');
const {
  ScrcpyStreamReader,
  CODEC_H264,
  CODEC_OPUS,
  STREAM_DISABLE,
  STREAM_ERROR,
  SCRCPY_REMOTE_PATH,
} = require('./stream-reader');

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
      // 慢客户端保护：积压 > 2MB 的客户端（隐藏/卡死的旧标签页）跳过视频帧，
      // 防止其拖慢广播与内存；音频/控制消息体量小，仍正常发送
      if (ws.readyState === ws.OPEN && ws.bufferedAmount < 2 * 1024 * 1024) ws.send(buf);
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

  /* ---------- 连接（无线） ---------- */
  async connect(addr, mode = 'wireless') {
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
          if (await this.tryAutoConnect(2, mode === 'auto' ? 'auto' : 'wireless')) return;
        } catch { /* 发现也失败：抛出原错误 */ }
      }
      this.setState('idle', '连接失败');
      throw err;
    }
  }

  /* ---------- 连接（USB 直连：无需 IP/端口，无需与电脑同一网络，数据走数据线） ---------- */
  async connectUsb() {
    if (this.state === 'streaming') throw new Error('投屏中，请先停止当前投屏');
    this.setState('connecting', '正在检测 USB 设备…');
    const adbPath = await this.ensureAdb();
    const list = await adbapi.devices(adbPath);
    const usb = list.find((s) => !adbapi.isWirelessSerial(s));
    if (!usb) {
      this.setState('idle', '未检测到 USB 设备');
      throw new Error('未检测到 USB 设备：请确认 ① 数据线已连接且手机 USB 模式选「传输文件」 ② 开发者选项中「USB 调试」已打开 ③ 手机弹窗「允许 USB 调试」已点允许');
    }
    this.serial = usb;
    this.setState('ready', '已通过 USB 连接：' + usb + '（最稳定链路，无需同一 Wi-Fi），可以开始投屏');
  }

  /** 通过 USB 直连 / mDNS / 已连接设备自动发现并连接；postPair 时轮询多次（配对后 adb 自动连接需要几秒）
   *  mode：'wireless'=仅无线（默认，配对/无线重试用）；'usb'=仅 USB；'auto'=USB 优先再无线 */
  async tryAutoConnect(attempts = 1, mode = 'wireless') {
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 1500));
      try {
        const adbPath = this.adbPath;
        // 1. USB 直连设备优先（仅 auto/usb 模式；插入数据线即用，绕开无线链路全部不稳定性）
        const list = await adbapi.devices(adbPath);
        if (mode === 'usb' || mode === 'auto') {
          const usb = list.find((s) => !adbapi.isWirelessSerial(s));
          if (usb) {
            this.serial = usb;
            this.setState('ready', '已通过 USB 连接：' + usb + '（最稳定链路，无需同一 Wi-Fi），可以开始投屏');
            return true;
          }
        }
        if (mode === 'usb') return false; // 明确只要 USB：不降级到无线
        // 2. mDNS 发现无线调试服务
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
        // 3. adb devices 里已就绪的无线设备（ip:port 或 mDNS 服务名）——先探活再采信：
        //    断开的旧传输可能在列表里残留「device」状态，直接采信会把失效端口写入缓存（v0.6.6）
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
    // 注意：绝不能在此处重置 stallTimes——自动重启链路中阶梯必须跨重启累计，
    // 否则永远停在第一级（v0.8.1 曾因此导致软件编码器切换从未生效）；
    // 手动停止后的重新开始由 ws-endpoint 的 'start' 消息处理时重置
    if (this.state === 'streaming') throw new Error('已在投屏中');
    try {
      this.setState('connecting', '正在准备投屏…');
      const adbPath = await this.ensureAdb();

      if (!this.serial) {
        // 未先连接就点开始：USB 优先，其次无线自动发现
        const ok = await this.tryAutoConnect(1, 'auto');
        if (!ok) throw new Error('尚未连接手机：请插线后点「USB 连接」，或无线配对后点「无线连接」');
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
      const wantScreenOff = options.screenOff === true; // 熄屏投屏（需 control 通道，见下方第三条 socket）
      if (wantScreenOff) this.screenOffUsed = true; // stop()/进程退出时强制唤醒兑底
      this.serverProc = adbapi.startScrcpyServer(adbPath, serial, tools.SCRCPY_VERSION, {
        bitrate: options.bitrate,
        maxSize: options.maxSize,
        maxFps: options.maxFps,
        audio: wantAudio,
        remotePath: SCRCPY_REMOTE_PATH,
        videoEncoder: options.videoEncoder, // v0.6.9 阶梯第③级：软件编码器（补全透传）
        control: wantScreenOff,
        turnScreenOff: wantScreenOff,
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

      // control=true（熄屏投屏）时：scrcpy 要等三条 socket 全部 accept 才开始编码出流，
      // 视频/音频都没有首字节可等（用 openStream 会死锁，v0.7.8 实测永久卡 connecting）；
      // 改为「连接成功且稳定 300ms」即视为建立（close/error 触发重试，语义一致）
      const openChannel = (label) => new Promise((resolve, reject) => {
        const deadline = Date.now() + 20000;
        const attempt = () => {
          if (!this.serverProc) { reject(new Error('scrcpy-server 启动失败或已退出')); return; }
          const sock = net.connect(this.forwardPort, '127.0.0.1');
          let stable = false;
          const retry = (why) => {
            if (stable) return;
            sock.destroy();
            if (Date.now() > deadline) reject(new Error(`${label}通道连接超时（${why}）`));
            else setTimeout(attempt, 300);
          };
          sock.once('error', (err) => retry(err.message));
          sock.once('close', () => retry('连接被关闭'));
          sock.once('connect', () => {
            setTimeout(() => { if (!stable) { stable = true; resolve(sock); } }, 300);
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
      const handleVideoChunk = (chunk) => {
        let buf = chunk;
        if (!dummySkipped) {
          dummySkipped = true;
          buf = chunk.subarray(1); // 跳过哑字节（send_dummy_byte=true 时视频 socket 的第 1 字节）
          if (!buf.length) return;
        }
        videoReader.push(buf);
      };
      // control=true（熄屏）走 openChannel（不等首字节，避免三 socket 死锁），
      // 否则走 openStream（等首字节确认，防 adb forward 假连接）
      const videoSocket = wantScreenOff
        ? await (async () => { const s = await openChannel('视频'); s.on('data', handleVideoChunk); return s; })()
        : await openStream('视频', handleVideoChunk);
      this.videoSocket = videoSocket;
      videoSocket.once('close', () => {
        if (this.state === 'streaming' && !this.stopping) {
          if (this.screenOffSentAt && Date.now() - this.screenOffSentAt < 8000) {
            this.log('⚠ 熄屏指令发出后通道立即断开：此 scrcpy 版本的熄屏协议不兼容，请取消勾选「熄屏投屏」后重试');
          }
          this.stop('视频通道已断开');
        }
      });
      videoSocket.once('error', () => {
        if (this.state === 'streaming' && !this.stopping) this.stop('视频通道断开');
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
          // control=true 时同样不等首字节（死锁同视频，v0.7.8 实测）
          audioSock = wantScreenOff
            ? await (async () => { const s = await openChannel('音频'); s.on('data', (chunk) => audioReader.push(chunk)); return s; })()
            : await openStream('音频', (chunk) => audioReader.push(chunk));
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

      // --- 控制 socket（仅熄屏投屏启用 control 时）：scrcpy 在 video→audio 之后 accept 第三条 ---
      // 控制通道是双向的，当前只接收不发送（剪贴板同步等设备→电脑消息，一律排空忽略）
      this.controlSocket = null;
      if (wantScreenOff) {
        try {
          this.controlSocket = await openChannel('控制');
          this.controlSocket.on('data', () => {}); // 排空设备→电脑消息
          this.controlSocket.once('error', () => {}); // 断开不影响投屏（只损失熄屏后恢复时机）
          // scrcpy ≥2.x 的熄屏走控制消息：TYPE_SET_DISPLAY_POWER(10) + 1 字节布尔（0=熄屏）。
          // （v5.0.1 已移除 turn_screen_off 服务端参数，dex 字符串表确认控制枚举存在）
          try {
            this.controlSocket.write(Buffer.from([10, 0]));
            this.screenOffSentAt = Date.now();
            this.log('已发送熄屏指令（若 3 秒内画面不更新或会话断开，请取消勾选熄屏投屏——该版本协议可能不兼容）');
          } catch {}
        } catch (err) {
          // 控制通道建不起来：scrcpy 会一直等 accept，编码器不会启动 → 整体失败比半残好
          throw err;
        }
      }

      this.setState('streaming', '投屏中 · ' + serial + (this.audioEnabled ? '（含声音）' : ''));
      // 流信息广播（前端指标面板展示：链路类型/码率/帧率/编码器/熄屏）
      this.broadcast({
        type: 'stream-info',
        link: /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(serial) ? 'wifi' : 'usb',
        bitrate: options.bitrate,
        maxFps: options.maxFps,
        softwareEncoder: !!options.videoEncoder,
        screenOff: wantScreenOff,
      });
      // USB 热切换（v0.7.7）：Wi-Fi 投屏期间插入数据线（开 USB 调试）→ 自动迁移到 USB 链路。
      // 每 5s 探测一次 adb devices；切换动作 = 停当前会话 + 用 USB serial 重开（同参数）
      if (this.usbWatchTimer) clearInterval(this.usbWatchTimer);
      this.usbWatchTimer = null;
      if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(serial)) {
        this.usbWatchTimer = setInterval(async () => {
          if (this.state !== 'streaming' || !this.usbWatchTimer) return;
          try {
            const list = await adbapi.devices(adbPath);
            const usb = list.find((s) => !adbapi.isWirelessSerial(s));
            if (usb && this.state === 'streaming') {
              clearInterval(this.usbWatchTimer);
              this.usbWatchTimer = null;
              this.log('🔌 检测到 USB 连接（' + usb + '），自动切换到 USB 链路…');
              this.serial = usb;
              const switchOpts = { ...this.lastStartOptions };
              await this.stop('检测到 USB 连接，自动切换链路');
              await this.start(switchOpts);
            }
          } catch { /* 探测失败下一轮再试 */ }
        }, 5000);
      }
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
    // 防重入：stop 进行中时旧 socket 的 close/error 事件会再次触发 stop（USB 热切换实测
    // 会嵌套破坏新会话的转发端口导致「启动失败」），嵌套调用直接忽略
    if (this.stopping) return;
    this.stopping = true;
    try {
      await this.stopInner(reason);
    } finally {
      this.stopping = false;
    }
  }

  async stopInner(reason = '已停止') {
    if (this.qrPair) this.cancelQrPairing();
    if (this.videoSocket) {
      try { this.videoSocket.destroy(); } catch {}
      this.videoSocket = null;
    }
    if (this.audioSocket) {
      try { this.audioSocket.destroy(); } catch {}
      this.audioSocket = null;
    }
    if (this.controlSocket && this.screenOffUsed) {
      // 熄屏恢复亮屏：TYPE_SET_DISPLAY_POWER(10) + 1 = 亮屏（与 scrcpy 自身退出恢复、keyevent 三重保险）
      try { this.controlSocket.write(Buffer.from([10, 1])); } catch {}
    }
    if (this.controlSocket) {
      try { this.controlSocket.destroy(); } catch {}
      this.controlSocket = null;
    }
    if (this.screenOffUsed) {
      // 熄屏投屏恢复：scrcpy 正常退出会自行恢复电源状态，这里强制唤醒兑底（防强杀残留黑屏）
      this.screenOffUsed = false;
      try { await adbapi.shell(this.adbPath, this.serial, 'input keyevent 224'); } catch {}
    }
    this.audioEnabled = false;
    clearInterval(this.audioStatsTimer);
    this.audioStatsTimer = null;
    if (this.usbWatchTimer) { clearInterval(this.usbWatchTimer); this.usbWatchTimer = null; }
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

module.exports = { WirelessSession };
