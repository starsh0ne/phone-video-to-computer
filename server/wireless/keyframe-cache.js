/**
 * H.264 Annex-B 关键帧缓存：
 * 保留 SPS/PPS 与最近一个 IDR 起始的全部数据，新加入的页面先收缓存再收实时流，
 * 无需等待下一个 GOP（scrcpy 默认关键帧间隔约 10s）。
 */
'use strict';

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

module.exports = { KeyframeCache };
