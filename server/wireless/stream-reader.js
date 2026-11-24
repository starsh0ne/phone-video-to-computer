/**
 * scrcpy v3+ 流解析器（send_stream_meta=true + send_frame_meta=true 的线格式）：
 *   [4 字节编码器 id（大端）]  之后为若干帧：
 *   - 会话元数据（首 8 字节最高位为 1）：12 字节 flags+width+height，跳过
 *   - 普通帧：[8 字节 PTS+标志（大端）][4 字节包长（大端）][载荷]
 *     bit62=配置包（视频 CSD / 音频 OpusHead），bit61=关键帧
 * 音频流特例：首 4 字节若为 0x00000000 表示设备禁用音频（继续仅视频），
 * 0x00000001 表示配置错误（服务端会退出）。
 */
'use strict';

/* 常量：scrcpy 编码器 id（4 字节 ASCII）与流状态 */
const CODEC_H264 = 0x68323634;      // 'h264'
const CODEC_OPUS = 0x6f707573;      // 'opus'
const STREAM_DISABLE = 0x00000000;  // 设备禁用该流（如 Android <11 无法采集音频）
const STREAM_ERROR = 0x00000001;    // 配置错误

/* scrcpy-server 在手机端的部署路径（push 与启动参数共用） */
const SCRCPY_REMOTE_PATH = '/data/local/tmp/scrcpy-server';

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

module.exports = {
  ScrcpyStreamReader,
  CODEC_H264,
  CODEC_OPUS,
  STREAM_DISABLE,
  STREAM_ERROR,
  SCRCPY_REMOTE_PATH,
};
