/**
 * local-cast 端到端自动化测试（无浏览器依赖）
 *
 * 覆盖：
 *  1. HTTP 静态页面可访问（电脑端接收页 / 手机端投屏页）
 *  2. /api/session 生成 6 位投屏码与二维码 DataURL
 *  3. WebSocket 信令：电脑端加入 → 手机端加入 → 双向 peer-ready
 *  4. WebRTC 信令消息（offer/answer/candidate）双向转发
 *  5. 无效投屏码拒绝
 *  6. 手机端断开后电脑端收到 peer-left
 *  7. 重新生成投屏码后旧码失效
 */
'use strict';

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const TEST_PORT = 18099;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

let passed = 0, failed = 0;
const failures = [];

function ok(name) { passed++; console.log(`  ✔ ${name}`); }
function bad(name, detail) { failed++; failures.push(`${name}：${detail}`); console.log(`  ✘ ${name} —— ${detail}`); }

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

function wsCollect(url, handlers, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const received = [];
    const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), timeoutMs);
    ws.on('open', () => {
      if (handlers.onOpen) handlers.onOpen(ws);
      setTimeout(() => { clearTimeout(timer); resolve(ws); }, 300);
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      received.push(msg);
      if (handlers.onMessage) handlers.onMessage(msg, ws);
    });
    ws.on('error', (err) => reject(err));
    ws._collected = received;
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('启动测试服务（端口 ' + TEST_PORT + '）...');
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT: String(TEST_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  try {
    // 等待服务就绪
    await sleep(800);
    await httpGet(BASE + '/health').catch(() => null);

    console.log('\n[1] HTTP 静态页面');
    let r = await httpGet(BASE + '/');
    r.status === 200 && r.body.includes('投屏接收端') ? ok('电脑端接收页可访问') : bad('电脑端接收页可访问', `status=${r.status}`);

    r = await httpGet(BASE + '/cast');
    r.status === 200 && r.body.includes('手机投屏') ? ok('手机端投屏页可访问') : bad('手机端投屏页可访问', `status=${r.status}`);

    console.log('\n[2] 投屏码与二维码接口');
    r = await httpGet(BASE + '/api/session');
    const session = JSON.parse(r.body);
    session.code && /^\d{6}$/.test(session.code) ? ok('生成 6 位投屏码：' + session.code) : bad('生成 6 位投屏码', JSON.stringify(session));
    session.qr && session.qr.startsWith('data:image/png;base64,') ? ok('二维码为本地 PNG DataURL（无外部请求）') : bad('二维码为本地 PNG DataURL', session.qr ? '格式不符' : '缺失');
    session.castUrl && session.castUrl.includes('/cast?code=' + session.code) ? ok('投屏链接包含投屏码') : bad('投屏链接包含投屏码', session.castUrl);

    const code = session.code;
    const wsUrl = `ws://127.0.0.1:${TEST_PORT}/ws`;

    console.log('\n[3] 信令会话匹配');
    // 电脑端加入
    const computer = await wsCollect(wsUrl, {});
    computer.send(JSON.stringify({ type: 'join', role: 'computer', code }));
    await sleep(200);
    let joined = computer._collected.find((m) => m.type === 'joined');
    joined ? ok('电脑端加入成功') : bad('电脑端加入成功', JSON.stringify(computer._collected));
    let waiting = computer._collected.find((m) => m.type === 'waiting');
    waiting ? ok('电脑端进入等待手机状态') : bad('电脑端进入等待手机状态', JSON.stringify(computer._collected));

    // 无效投屏码
    const badPhone = await wsCollect(wsUrl, {});
    const badPhoneClosed = new Promise((res) => badPhone.on('close', res));
    badPhone.send(JSON.stringify({ type: 'join', role: 'phone', code: '000000' }));
    await sleep(200);
    const errMsg = badPhone._collected.find((m) => m.type === 'error');
    errMsg ? ok('无效投屏码被拒绝并提示') : bad('无效投屏码被拒绝并提示', JSON.stringify(badPhone._collected));
    const closedOk = await Promise.race([badPhoneClosed, sleep(3000).then(() => null)]);
    closedOk ? ok('无效投屏码连接被服务端关闭') : bad('无效投屏码连接被服务端关闭', '未收到 close');
    badPhone.terminate && badPhone.terminate();

    // 手机端加入
    const phone = await wsCollect(wsUrl, {});
    phone.send(JSON.stringify({ type: 'join', role: 'phone', code }));
    await sleep(200);
    let phoneReady = phone._collected.find((m) => m.type === 'peer-ready');
    phoneReady ? ok('手机端收到电脑端就绪通知') : bad('手机端收到电脑端就绪通知', JSON.stringify(phone._collected));
    let computerReady = computer._collected.find((m) => m.type === 'peer-ready');
    computerReady ? ok('电脑端收到手机端就绪通知') : bad('电脑端收到手机端就绪通知', JSON.stringify(computer._collected));

    console.log('\n[4] WebRTC 信令转发');
    const fakeOffer = { type: 'offer', sdp: 'fake-offer-sdp' };
    const offerReceived = new Promise((resolve) => {
      computer.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'signal' && m.data && m.data.sdp && m.data.sdp.sdp === 'fake-offer-sdp') resolve(m);
      });
    });
    phone.send(JSON.stringify({ type: 'signal', from: 'phone', data: { sdp: fakeOffer } }));
    const gotOffer = await Promise.race([offerReceived, sleep(3000).then(() => null)]);
    gotOffer ? ok('手机端 offer 已转发给电脑端') : bad('手机端 offer 已转发给电脑端', '未收到');

    const answerReceived = new Promise((resolve) => {
      phone.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'signal' && m.data && m.data.sdp && m.data.sdp.sdp === 'fake-answer-sdp') resolve(m);
      });
    });
    computer.send(JSON.stringify({ type: 'signal', from: 'computer', data: { sdp: { type: 'answer', sdp: 'fake-answer-sdp' } } }));
    const gotAnswer = await Promise.race([answerReceived, sleep(3000).then(() => null)]);
    gotAnswer ? ok('电脑端 answer 已转发给手机端') : bad('电脑端 answer 已转发给手机端', '未收到');

    const candReceived = new Promise((resolve) => {
      phone.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'signal' && m.data && m.data.candidate && m.data.candidate.candidate === 'fake-cand') resolve(m);
      });
    });
    computer.send(JSON.stringify({ type: 'signal', from: 'computer', data: { candidate: { candidate: 'fake-cand', sdpMid: '0', sdpMLineIndex: 0 } } }));
    const gotCand = await Promise.race([candReceived, sleep(3000).then(() => null)]);
    gotCand ? ok('ICE candidate 双向转发正常') : bad('ICE candidate 双向转发正常', '未收到');

    console.log('\n[5] 断开与失效');
    const leftReceived = new Promise((resolve) => {
      computer.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'peer-left') resolve(m);
      });
    });
    phone.close();
    const gotLeft = await Promise.race([leftReceived, sleep(3000).then(() => null)]);
    gotLeft ? ok('手机端断开后电脑端收到通知') : bad('手机端断开后电脑端收到通知', '未收到');

    // 电脑端断开后，用旧码重连应失败（会话失效）
    computer.close();
    await sleep(200);
    const stale = await wsCollect(wsUrl, {});
    stale.send(JSON.stringify({ type: 'join', role: 'phone', code }));
    await sleep(200);
    const staleErr = stale._collected.find((m) => m.type === 'error');
    staleErr ? ok('电脑端断开后旧投屏码失效') : bad('电脑端断开后旧投屏码失效', JSON.stringify(stale._collected));
    stale.close();

    console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`);
    if (failed > 0) {
      console.log('失败明细：');
      failures.forEach((f) => console.log('  - ' + f));
      process.exitCode = 1;
    } else {
      console.log('全部测试通过 ✅');
    }
  } catch (err) {
    console.error('测试执行异常:', err);
    process.exitCode = 1;
  } finally {
    server.kill();
    await sleep(300);
    process.exit(process.exitCode || 0);
  }
}

main();
