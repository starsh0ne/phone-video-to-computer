/**
 * 单元测试：无线投屏模块核心逻辑（不依赖 adb / 网络 / 端口）
 * 运行：node test/wireless.test.js
 */
'use strict';

const assert = require('assert');
const { KeyframeCache, generateQrPairingSecrets, ScrcpyStreamReader, CODEC_H264, CODEC_OPUS, STREAM_DISABLE } = require('../server/wireless');
const connStore = require('../server/connection-store');
const adbapi = require('../server/adb');
const tools = require('../server/tools');

// H.264 NAL：4 字节起始码 + header(forbidden=0, ref_idc=3, type<<0)
// header 字节 = 0x60 | type（SPS=0x67, PPS=0x68, IDR=0x65, slice=0x61）
function nal(type, payloadLen = 10) {
  const buf = Buffer.alloc(4 + 1 + payloadLen);
  buf[0] = 0; buf[1] = 0; buf[2] = 0; buf[3] = 1;
  buf[4] = 0x60 | type;
  for (let i = 0; i < payloadLen; i++) buf[5 + i] = 0xAB;
  return buf;
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* ---------------- KeyframeCache ---------------- */

test('无关键帧时 bootstrap 为空', () => {
  const c = new KeyframeCache();
  assert.strictEqual(c.bootstrap().length, 0);
});

test('关键帧前到达的数据不进入引导缓存', () => {
  const c = new KeyframeCache();
  c.push(nal(1, 5)); // IDR 之前的 slice
  assert.strictEqual(c.bootstrap().length, 0);
});

test('SPS/PPS/IDR 后 bootstrap = SPS+PPS+IDR', () => {
  const c = new KeyframeCache();
  const sps = nal(7, 8);
  const pps = nal(8, 4);
  const idr = nal(5, 20);
  c.push(Buffer.concat([sps, pps, idr]));
  const boot = c.bootstrap();
  // 缓存中 SPS/PPS 各带 1 个尾随前导 0（作为下一 NAL 的 4 字节起始码前导），
  // IDR 以 3 字节起始码开头：三者拼接为合法 Annex-B 流
  const expected = sps.length + pps.length + (idr.length - 1);
  assert.strictEqual(boot.length, expected);
  assert.strictEqual(boot[3] & 0x1f, 7, '第一个 NAL 应为 SPS');
  assert.ok(boot.slice(-(idr.length - 1)).equals(idr.slice(1)), '尾部应为 IDR 数据');
});

test('新 IDR 到达后缓存重置到新关键帧', () => {
  const c = new KeyframeCache();
  const sps = nal(7, 8);
  const pps = nal(8, 4);
  c.push(Buffer.concat([sps, pps, nal(5, 10), nal(1, 6)]));
  const newIdr = nal(5, 40);
  const slice = nal(1, 6);
  c.push(Buffer.concat([newIdr, slice]));
  const boot = c.bootstrap();
  // 期望：SPS + PPS + 新IDR(3字节起始码) + slice(原始 4 字节起始码保留)
  const expected = sps.length + pps.length + (newIdr.length - 1) + slice.length;
  assert.strictEqual(boot.length, expected);
});

test('IDR 跨 chunk 到达也能正确识别', () => {
  const c = new KeyframeCache();
  const sps = nal(7, 8);
  const pps = nal(8, 4);
  const idr = nal(5, 30);
  c.push(Buffer.concat([sps, pps, idr.slice(0, 10)]));
  // 部分到达：SPS/PPS 已记录，IDR 尚不完整（此时引导数据不可解码，属预期行为）
  c.push(idr.slice(10));
  const boot = c.bootstrap();
  // SPS/PPS 各带尾随前导 0，IDR 以 3 字节起始码开头
  const expected = sps.length + pps.length + (idr.length - 1);
  assert.strictEqual(boot.length, expected);
  assert.ok(boot.slice(-(idr.length - 1)).equals(idr.slice(1)), '应包含完整 IDR');
});

test('缓存超限保护不崩溃', () => {
  const c = new KeyframeCache(1024);
  const big = Buffer.alloc(4096, 0xAB);
  big[0] = 0; big[1] = 0; big[2] = 0; big[3] = 1; big[4] = 0x65; // IDR
  c.push(big);
  for (let i = 0; i < 20; i++) c.push(nal(1, 500));
  // 不抛错即通过
  assert.ok(c.buffer.length <= 1024);
});

/* ---------------- adb 参数封装 ---------------- */

test('pair 地址/配对码格式校验', async () => {
  await assert.rejects(() => adbapi.pair(null, 'x', '123456'), /配对地址格式/);
  // code 支持任意非空字符串（二维码配对密码为 20 位字母数字），6 位数字限制由前端校验
  await assert.rejects(() => adbapi.pair(null, '192.168.1.5:39987', ''), /配对码/);
  await assert.rejects(() => adbapi.pair(null, '192.168.1.5:39987', '  '), /配对码/);
});

test('connect 地址格式校验', async () => {
  await assert.rejects(() => adbapi.connect(null, 'not-an-addr'), /连接地址格式/);
});

/* ---------------- 工具链镜像 ---------------- */

test('scrcpy-server 下载镜像含官方源与回退源', () => {
  const urls = tools.scrcpyServerUrls();
  assert.ok(urls[0].includes('github.com/Genymobile/scrcpy'));
  assert.strictEqual(urls.length, 4);
});

test('platform-tools 镜像按平台选择正确的包', () => {
  const urls = tools.platformToolsUrls();
  const file = process.platform === 'win32' ? 'platform-tools-latest-windows.zip'
    : process.platform === 'darwin' ? 'platform-tools-latest-darwin.zip'
      : 'platform-tools-latest-linux.zip';
  assert.ok(urls[0].endsWith(file));
});


/* ---------------- 二维码配对 ---------------- */

test('generateQrPairingSecrets 生成合法的 WIFI:T:ADB 配对载荷', () => {
  const s = generateQrPairingSecrets();
  assert.ok(/^studio-[A-Za-z0-9]{10}$/.test(s.instance), '实例名格式：studio-+10位字母数字');
  assert.ok(/^[A-Za-z0-9]{20}$/.test(s.password), '密码为20位纯字母数字');
  assert.ok(s.qrString.startsWith('WIFI:T:ADB;S:'));
  assert.ok(s.qrString.includes(';P:' + s.password + ';;'));
  // 随机部分均为纯字母数字（studio- 前缀的连字符无需转义），WIFI: 串无需转义处理
  assert.ok(!/[^A-Za-z0-9]/.test(s.instance.slice('studio-'.length) + s.password), '实例名/密码不含需转义字符');
});

test('两次生成的配对密钥互不相同', () => {
  const a = generateQrPairingSecrets();
  const b = generateQrPairingSecrets();
  assert.notStrictEqual(a.instance, b.instance);
  assert.notStrictEqual(a.password, b.password);
});

/* ---------------- mDNS 解析 ---------------- */

test('parseMdnsServices 解析标准三列输出', () => {
  const lines = [
    'adb-XXX-QXjCrW _adb-tls-pairing._tcp 192.168.86.38:33861',
    'adb-YYY-Zz9999 _adb-tls-connect._tcp 192.168.86.38:37123',
  ];
  const svcs = adbapi.parseMdnsServices(lines.join('\n'));
  assert.strictEqual(svcs.length, 2);
  assert.strictEqual(svcs[0].name, 'adb-XXX-QXjCrW');
  assert.strictEqual(svcs[0].type, '_adb-tls-pairing._tcp');
  assert.strictEqual(svcs[0].addr, '192.168.86.38:33861');
});

test('parseMdnsServices 忽略表头/空行/列数不足的行', () => {
  const out = adbapi.parseMdnsServices(['List of discovered mdns services', '', 'bad-line', 'a b'].join('\n'));
  assert.strictEqual(out.length, 0);
});

test('parseMdnsServices 对 null/undefined 输入安全', () => {
  assert.strictEqual(adbapi.parseMdnsServices(null).length, 0);
  assert.strictEqual(adbapi.parseMdnsServices(undefined).length, 0);
});

/* ---------------- scrcpy 流解析器 ---------------- */

function frame(pts, config, key, payload) {
  const head = Buffer.alloc(12);
  let v = BigInt(pts);
  if (config) v |= (1n << 62n);
  if (key) v |= (1n << 61n);
  head.writeBigUInt64BE(v);
  head.writeUInt32BE(payload.length, 8);
  return Buffer.concat([head, payload]);
}

test('ScrcpyStreamReader 解析 codec 头 + 普通帧 + 配置帧 + 关键帧标志', () => {
  const headers = [];
  const pkts = [];
  const r = new ScrcpyStreamReader({ onHeader: (id) => headers.push(id), onPacket: (p) => pkts.push(p) });
  const payload1 = Buffer.from([1, 2, 3, 4]);
  const payload2 = Buffer.from([9, 9]);
  r.push(Buffer.concat([Buffer.from([0x68, 0x32, 0x36, 0x34]), frame(1000, false, false, payload1), frame(2000, true, false, payload2)]));
  assert.deepStrictEqual(headers, [CODEC_H264]);
  assert.strictEqual(pkts.length, 2);
  assert.strictEqual(pkts[0].pts, 1000);
  assert.strictEqual(pkts[0].config, false);
  assert.strictEqual(pkts[0].keyFrame, false);
  assert.ok(pkts[0].payload.equals(payload1));
  assert.strictEqual(pkts[1].config, true);
  assert.ok(pkts[1].payload.equals(payload2));
});

test('ScrcpyStreamReader 帧跨 chunk 到达也能正确解析', () => {
  const pkts = [];
  const r = new ScrcpyStreamReader({ onPacket: (p) => pkts.push(p) });
  const payload = Buffer.alloc(50, 0xab);
  const whole = Buffer.concat([Buffer.from([0x6f, 0x70, 0x75, 0x73]), frame(500, false, true, payload)]);
  r.push(whole.subarray(0, 7));   // 半个头
  r.push(whole.subarray(7, 20));  // 半帧
  r.push(whole.subarray(20));     // 剩余
  assert.strictEqual(pkts.length, 1);
  assert.strictEqual(pkts[0].keyFrame, true);
  assert.ok(pkts[0].payload.equals(payload));
});

test('ScrcpyStreamReader 跳过会话元数据包（最高位为 1）', () => {
  const pkts = [];
  const r = new ScrcpyStreamReader({ onPacket: (p) => pkts.push(p) });
  const meta = Buffer.alloc(12);
  meta.writeUInt32BE(0x80000000, 0);
  meta.writeUInt32BE(1920, 4);
  meta.writeUInt32BE(1080, 8);
  const payload = Buffer.from([5]);
  r.push(Buffer.concat([Buffer.from([0x68, 0x32, 0x36, 0x34]), meta, frame(1, false, false, payload)]));
  assert.strictEqual(pkts.length, 1);
  assert.ok(pkts[0].payload.equals(payload));
});

test('ScrcpyStreamReader 头部未收齐（<4 字节）不误触发', () => {
  const headers = [];
  const r = new ScrcpyStreamReader({ onHeader: (id) => headers.push(id) });
  r.push(Buffer.from([0x6f, 0x70]));
  assert.strictEqual(headers.length, 0);
  r.push(Buffer.from([0x75, 0x73]));
  assert.deepStrictEqual(headers, [CODEC_OPUS]);
});

/* ---------------- 连接地址持久化 ---------------- */

test('connection-store 保存并读回合法地址', () => {
  connStore.save('192.168.137.141:38051');
  const l = connStore.load();
  assert.ok(l);
  assert.strictEqual(l.addr, '192.168.137.141:38051');
  assert.ok(l.savedAt > 0);
});

test('connection-store 对非法/损坏数据返回 null', () => {
  const fs = require('fs');
  fs.writeFileSync(require('path').join(__dirname, '..', 'data', 'last-connection.json'), 'not-json{', 'utf8');
  assert.strictEqual(connStore.load(), null);
  connStore.save('192.168.137.141:38051'); // 恢复
});
/* ---------------- 异步顺序执行 ---------------- */

(async () => {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log('  ✓ ' + name);
    } catch (err) {
      failed++;
      console.error('  ✗ ' + name + '\n    ' + (err && err.message));
    }
  }
  console.log('');
  console.log(`结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
