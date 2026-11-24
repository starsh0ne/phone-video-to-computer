/**
 * 无线投屏模块门面：保持 `require('../server/wireless')` 的既有导入面不变。
 * 模块职责划分：
 *   session.js      会话生命周期状态机（连接/开流/停止/亮屏保持）
 *   stream-reader.js scrcpy 线格式解析 + 编码器常量（纯逻辑）
 *   keyframe-cache.js 关键帧缓存（纯逻辑）
 *   pairing.js      二维码配对密钥生成（纯逻辑）
 *   stall-policy.js  停滞降载阶梯与熔断（纯策略，可单测）
 *   ws-endpoint.js  /wireless WebSocket 路由与消息分发
 */
'use strict';

const { setupWireless } = require('./ws-endpoint');
const { WirelessSession } = require('./session');
const { KeyframeCache } = require('./keyframe-cache');
const { generateQrPairingSecrets } = require('./pairing');
const { ScrcpyStreamReader, CODEC_H264, CODEC_OPUS, STREAM_DISABLE, STREAM_ERROR } = require('./stream-reader');

module.exports = {
  setupWireless,
  WirelessSession,
  KeyframeCache,
  ScrcpyStreamReader,
  generateQrPairingSecrets,
  CODEC_H264,
  CODEC_OPUS,
  STREAM_DISABLE,
  STREAM_ERROR,
};
