
class RingBufferProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = Math.ceil(sampleRate * 1.0);
    this.buf = new Float32Array(this.cap * 2); // 立体声交错
    this.writePos = 0;
    this.readPos = 0;
    this.available = 0;      // 可读帧数
    this.playing = false;
    this.dataPort = null;    // worker 直连端口（bind-port 后生效）
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.cmd === 'write') {
        this.writeRing(d.data, d.frames);
      } else if (d.cmd === 'flush') {
        this.writePos = 0; this.readPos = 0; this.available = 0; this.playing = false;
        if (this.dataPort) { try { this.dataPort.close(); } catch (err) {} this.dataPort = null; }
      } else if (d.cmd === 'bind-port') {
        // 接收从主线程转移进来的 MessagePort：worker 的 PCM 由此直达，主线程零参与
        this.dataPort = d.port;
        this.dataPort.onmessage = (ev) => {
          const m = ev.data;
          if (m && m.cmd === 'write') this.writeRing(m.data, m.frames);
        };
        // 握手：告诉主线程端口确实接上了（收不到就说明转移失败，必须回退主线程解码）
        this.port.postMessage({ event: 'bind-ack' });
      }
    };
  }
  writeRing(data, n) {
    // 深水位延迟校正（v0.7.5）：水位 >350ms 即丢回 200ms——稳态下到达=消耗速率，
    // 突发追赶的堆积无法自愈，音画长期偏移；与视频呈现的固定 150ms 目标配合，
    // 音画差可控制在 ±100ms 内。音频会有一次轻微跳跃
    if (this.available > sampleRate * 0.35) {
      const excess = this.available - Math.floor(sampleRate * 0.2);
      if (excess > 0) {
        this.readPos = (this.readPos + excess) % this.cap;
        this.available -= excess;
        this.port.postMessage({ event: 'buffer-correct', droppedMs: Math.round(excess / sampleRate * 1000) });
      }
    }
    // 逐帧写（交错数据跨环形边界不错位）
    for (let f = 0; f < n; f++) {
      this.buf[this.writePos * 2] = data[f * 2];
      this.buf[this.writePos * 2 + 1] = data[f * 2 + 1];
      this.writePos = (this.writePos + 1) % this.cap;
    }
    this.available = Math.min(this.available + n, this.cap);
  }
  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const n = L.length;
    // 每约 1 秒上报一次缓冲水位（主线程指标面板 + 音画同步目标用；音频线程 postMessage 开销可控）
    this.reportBlocks = (this.reportBlocks || 0) + 1;
    if (this.reportBlocks >= 375) { // 48kHz / 128 采样块 ≈ 375 块/秒
      this.reportBlocks = 0;
      this.port.postMessage({ event: 'buffer', ms: Math.round(this.available / sampleRate * 1000) });
    }
    if (!this.playing) {
      if (this.available >= sampleRate * 0.15) {
        this.playing = true;
        this.port.postMessage({ event: 'start' });
      } else {
        L.fill(0); R.fill(0);
        return true;
      }
    }
    let got = 0;
    if (this.available >= n) {
      for (let i = 0; i < n; i++) {
        L[i] = this.buf[this.readPos * 2];
        R[i] = this.buf[this.readPos * 2 + 1];
        this.readPos = (this.readPos + 1) % this.cap;
      }
      this.available -= n;
      got = n;
    }
    if (got < n) {
      // 欠载：本块剩余补零，保持播放时钟连续；缓冲回升后自动接上
      for (let i = got; i < n; i++) { L[i] = 0; R[i] = 0; }
      if (got > 0 && this.available === 0) this.port.postMessage({ event: 'underrun' });
    }
    return true;
  }
}
registerProcessor('ring-buffer-processor', RingBufferProcessor);
