/**
 * 单元测试：视频流停滞降载阶梯与熔断策略（server/wireless/stall-policy.js）
 * 运行：node test/stall-policy.test.js
 */
'use strict';

const assert = require('assert');
const { planStallRestart, MAX_RESTARTS_PER_WINDOW } = require('../server/wireless/stall-policy');

const NOW = 1000000;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const BASE_OPTS = { bitrate: 16000000, maxSize: 1920, maxFps: 60 };

function run(stallCount, opts = BASE_OPTS) {
  // 构造：窗口内已有 stallCount-1 次停滞，本次是第 stallCount 次
  const stallTimes = [];
  for (let i = 1; i < stallCount; i++) stallTimes.push(NOW - 60000 * i);
  return planStallRestart({ stallTimes, options: opts, now: NOW });
}

test('第 1 次停滞：仅重启，参数不变', () => {
  const r = run(1);
  assert.strictEqual(r.restart, true);
  assert.strictEqual(r.stallTimes.length, 1);
  assert.strictEqual(r.restartOpts.bitrate, 16000000);
  assert.strictEqual(r.messages.length, 0);
});

test('第 2 次停滞：码率降 25%（16M → 12M）', () => {
  const r = run(2);
  assert.strictEqual(r.restart, true);
  assert.strictEqual(r.restartOpts.bitrate, 12000000);
  assert.ok(r.messages[0].includes('12.0 Mbps'));
});

test('第 3 次停滞：切换软件编码器 + 30fps + 码率压到 6M', () => {
  const r = run(3);
  assert.strictEqual(r.restart, true);
  assert.strictEqual(r.restartOpts.videoEncoder, 'c2.android.avc.encoder');
  assert.strictEqual(r.restartOpts.maxFps, 30);
  assert.strictEqual(r.restartOpts.bitrate, 6000000);
  assert.ok(r.messages[0].includes('软件编码器'));
});

test('阶梯只升不降：第 4 次停滞保持软件编码器，不再改参数', () => {
  const r = run(4, { bitrate: 6000000, maxSize: 1920, maxFps: 30, videoEncoder: 'c2.android.avc.encoder' });
  assert.strictEqual(r.restart, true);
  assert.strictEqual(r.restartOpts.videoEncoder, 'c2.android.avc.encoder');
  assert.strictEqual(r.restartOpts.bitrate, 6000000);
  assert.strictEqual(r.messages.length, 0);
});

test(`第 ${MAX_RESTARTS_PER_WINDOW + 1} 次停滞：熔断，不再自动重启`, () => {
  const r = run(MAX_RESTARTS_PER_WINDOW + 1);
  assert.strictEqual(r.restart, false);
  assert.ok(r.messages[0].includes('已暂停自动重启'));
});

test('窗口外（>10 分钟）的旧停滞不计入阶梯', () => {
  // 窗口内只有 1 次（本次），窗口外有 5 次 → 应视为第 1 次
  const stallTimes = [NOW - 11 * 60 * 1000, NOW - 12 * 60 * 1000, NOW - 13 * 60 * 1000,
    NOW - 14 * 60 * 1000, NOW - 15 * 60 * 1000];
  const r = planStallRestart({ stallTimes, options: BASE_OPTS, now: NOW });
  assert.strictEqual(r.restart, true);
  assert.strictEqual(r.stallTimes.length, 1);
  assert.strictEqual(r.restartOpts.bitrate, 16000000);
});

test('restartOpts 是副本：不污染调用方的 lastStartOptions', () => {
  const opts = { bitrate: 16000000 };
  const r = run(3, opts);
  assert.strictEqual(r.restartOpts.videoEncoder, 'c2.android.avc.encoder');
  assert.strictEqual(opts.videoEncoder, undefined);
});

/* ---------------- 顺序执行 ---------------- */

(async () => {
  let passed = 0, failed = 0;
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
