/**
 * adb 命令封装：无线配对（pair，支持配对码与二维码密码）、连接（connect）、
 * 端口转发（forward）、文件推送（push）、shell 执行（含流式输出）。
 *
 * adb 子进程由 platform-tools 提供（tools.js 负责定位/下载），密钥由 adb 自行管理
 * （首次配对后写入 ~/.android/adbkey，之后无需重复配对）。
 */
'use strict';

const { spawn } = require('child_process');
const net = require('net');

/**
 * 执行 adb 命令（带流式输出回调）。
 * onLine 会在收到 stdout/stderr 的每一行时被调用（实时反馈到页面）。
 * 超时/退出码非 0 时 reject；resolve { stdout, stderr }。
 */
function adbStream(adbPath, args, { timeoutMs = 60000, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(adbPath, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill(); } catch {}
        reject(new Error('命令超时：adb ' + args.join(' ')));
      }
    }, timeoutMs);
    const feed = (d) => {
      const text = d.toString();
      if (onLine) {
        for (const line of text.split(/\r?\n/)) {
          const t = line.trim();
          if (t) onLine(t);
        }
      }
    };
    child.stdout.on('data', (d) => { stdout += d.toString(); feed(d); });
    child.stderr.on('data', (d) => { stderr += d.toString(); feed(d); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('无法启动 adb：' + err.message));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error((stderr || stdout || `adb 退出码 ${code}`).trim()));
    });
  });
}

/** 执行 adb 命令（无流式回调），超时/退出码非 0 时 reject */
function adb(adbPath, args, timeoutMs = 30000) {
  return adbStream(adbPath, args, { timeoutMs });
}

/**
 * 无线配对：adb pair <ip:port> <code>
 * code 既可以是 6 位配对码，也可以是二维码配对生成的密码（任意字符串）。
 * addr/code 来自手机「无线调试 → 使用配对码配对设备」弹窗（或 mDNS 发现的配对服务）。
 */
async function pair(adbPath, addr, code, opts = {}) {
  if (!/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(addr)) {
    throw new Error('配对地址格式应为 IP:端口（例如 192.168.1.5:39987）。注意：必须使用手机「使用配对码配对设备」弹窗中显示的地址，不是无线调试主页的地址');
  }
  if (!String(code || '').trim()) {
    throw new Error('配对码不能为空（6 位数字，来自手机配对弹窗）');
  }
  const { stdout, stderr } = await adbStream(adbPath, ['pair', addr, String(code)], {
    timeoutMs: opts.timeoutMs || 60000,
    onLine: opts.onLine,
  });
  const out = (stdout + stderr).trim();
  if (/successfully paired|already paired|配对成功/i.test(out)) {
    return out;
  }
  throw new Error(out || '配对失败');
}

/** 无线连接：adb connect <ip:port>。返回标准化后的 serial（ip:port） */
async function connect(adbPath, addr) {
  if (!/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(addr)) {
    throw new Error('连接地址格式应为 IP:端口（例如 192.168.1.5:37555）。注意：此处使用无线调试主界面显示的地址，与配对弹窗的地址不同');
  }
  const { stdout, stderr } = await adb(adbPath, ['connect', addr], 20000);
  const out = (stdout + stderr).trim();
  if (/connected to|already connected/i.test(out)) {
    return addr;
  }
  throw new Error(out || '连接失败');
}

/** 解析 `adb mdns services` 输出 → [{name, type, addr}]（纯函数，便于测试） */
function parseMdnsServices(output) {
  const found = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const m = line.match(/^\s*(\S+)\s+(_adb\S*)\s+(\d{1,3}(?:\.\d{1,3}){3}:\d+)/);
    if (m) found.push({ name: m[1], type: m[2], addr: m[3] });
  }
  return found;
}

/** 查询 mDNS 发现的服务（adb mdns services） */
async function mdnsServicesDetailed(adbPath) {
  let out = '';
  try {
    const r = await adb(adbPath, ['mdns', 'services'], 8000);
    out = r.stdout + r.stderr;
  } catch (err) {
    out = String(err.message);
  }
  return parseMdnsServices(out);
}

/** 兼容旧接口：返回 _adb-tls-connect 服务的地址列表 */
async function mdnsServices(adbPath) {
  const list = await mdnsServicesDetailed(adbPath);
  return list.filter((s) => /_adb-tls-connect/.test(s.type)).map((s) => s.addr);
}

/** 列出已连接设备：adb devices，返回 serial 数组 */
async function devices(adbPath) {
  const { stdout } = await adb(adbPath, ['devices'], 10000);
  const list = [];
  for (const line of stdout.split(/\r?\n/).slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && parts[1] === 'device') list.push(parts[0]);
  }
  return list;
}

/** 判断 serial 是否为无线设备（ip:port 或 mDNS 服务名形式） */
function isWirelessSerial(serial) {
  return /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(serial) || /_adb-tls|_adb\./.test(serial);
}

/**
 * 建立端口转发：adb -s <serial> forward tcp:<localPort> localabstract:<name>
 * localPort 传 0 时由 adb 自动分配空闲端口，返回实际端口。
 */
async function forward(adbPath, serial, localPort, abstractName) {
  const { stdout } = await adb(adbPath, ['-s', serial, 'forward', `tcp:${localPort}`, `localabstract:${abstractName}`], 15000);
  const port = Number(stdout.trim());
  if (!port || Number.isNaN(port)) {
    throw new Error('无法建立端口转发：' + (stdout || 'adb 未返回端口').trim());
  }
  return port;
}

/** 移除转发 */
async function removeForward(adbPath, serial, localPort) {
  try {
    await adb(adbPath, ['-s', serial, 'forward', '--remove', `tcp:${localPort}`], 10000);
  } catch { /* 端口已不存在时忽略 */ }
}

/** 推送文件到设备 */
async function push(adbPath, serial, localPath, remotePath) {
  await adb(adbPath, ['-s', serial, 'push', localPath, remotePath], 60000);
}

/**
 * 拉起 scrcpy-server（长驻进程，stdout 流式返回日志）。
 * 返回 { child, cmd, stop() }。
 * 注意：
 * 1. 必须以 `CLASSPATH=<jar路径> app_process ...` 方式启动——app_process 依靠 CLASSPATH
 *    定位服务器 jar 中的类，缺失时新版 Android 上直接 SIGABRT（exit code 134，仅输出 "Aborted"）。
 * 2. 不能用 raw_stream=true（它会同时关掉音频的帧元数据，而 Opus 裸包无自定界能力，无法解码）。
 *    改用分粒度选项：保留 stream meta（4 字节编码器 id）与 frame meta（12 字节 PTS+长度头），
 *    由服务端解析帧头后分发视频/音频。
 */
/** 执行一条 shell 命令（成功/失败都 resolve，返回是否成功；用于 svc power stayon 等环境开关） */
function shell(adbPath, serial, command) {
  return new Promise((resolve) => {
    const child = spawn(adbPath, ['-s', serial, 'shell', command], { windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

function startScrcpyServer(adbPath, serial, serverVersion, options = {}) {
  const bitrate = options.bitrate || 16000000;
  // maxSize：0 = 不限制（手机原始分辨率）；未传 = 1920；>0 = 最长边上限
  const maxSize = options.maxSize === undefined ? 1920 : options.maxSize;
  const maxFps = options.maxFps || 0;
  const audio = options.audio !== false;
  const remotePath = options.remotePath || '/data/local/tmp/scrcpy-server';
  const args = [
    '-s', serial, 'shell',
    `CLASSPATH=${remotePath}`,
    'app_process', '/', 'com.genymobile.scrcpy.Server', serverVersion,
    'scid=-1',
    'log_level=info',
    'video=true',
    `audio=${audio}`,
    'control=false',
    'tunnel_forward=true',
    'audio_codec=opus',
    'audio_bit_rate=128000',
    'send_device_meta=false',
    // 哑字节必须开启：服务端接受视频 socket 后立即写 1 字节（先于音频 accept），
    // 用于确认视频通道——否则「等视频数据才连音频」会与服务端「等音频连接才启动编码器」死锁
    'send_dummy_byte=true',
    'send_stream_meta=true',
    'send_frame_meta=true',
    `video_bit_rate=${bitrate}`,
  ];
  if (maxSize > 0) args.push(`max_size=${maxSize}`);
  if (maxFps > 0) args.push(`max_fps=${maxFps}`);
  // v0.6.9：停滞阶梯第③级可指定编码器（c2.android.avc.encoder = Android 自带软件编码器，
  // 绕开 vivo 等厂商硬件编码器被系统冻结/出错的毛病；软件编码器带不动 60fps，需配 max_fps=30）
  if (options.videoEncoder) args.push(`video_encoder=${options.videoEncoder}`);
  // v0.6.4：投屏期间持有亮屏唤醒锁，减少手机系统省电策略冻结采集进程/熄屏导致的流中断
  // （vivo 等厂商对后台进程管控激进；熄屏时画面采集停摆、音频退化为静音包，正是日志里观察到的停摆形态）
  args.push('stay_awake=true');
  const child = spawn(adbPath, args, { windowsHide: true });
  let stopped = false;
  return {
    child,
    cmd: `adb ${args.join(' ')}`,
    stop() {
      if (stopped) return;
      stopped = true;
      try { child.kill(); } catch {}
    },
  };
}

/** 等待本机端口可连接（转发就绪探测） */
function waitLocalPort(port, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tryOnce = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`本地转发端口 ${port} 连接超时`));
        } else {
          setTimeout(tryOnce, 300);
        }
      });
    };
    tryOnce();
  });
}

module.exports = {
  adb,
  adbStream,
  pair,
  connect,
  shell,
  parseMdnsServices,
  mdnsServicesDetailed,
  mdnsServices,
  devices,
  isWirelessSerial,
  forward,
  removeForward,
  push,
  startScrcpyServer,
  waitLocalPort,
  adb,
};
