
'use strict';
let decoder = null;
let configured = false;
let outPort = null; // worklet 直连端口（init 时收到）
let feedCount = 0;
let peak = 0;
let decodeCount = 0;
let levelPeak = 0;   // 500ms 窗口峰值累计
let levelCount = 0;  // 窗口内帧数
let silenceChecked = false;
const SR = 48000;
const FRAME_US = 20000;
function post(type, msg) { self.postMessage(Object.assign({ type: type }, msg || {})); }
self.onmessage = (e) => {
  const d = e.data;
  if (d.type === 'config') {
    const payload = new Uint8Array(d.data);
    if (payload.length >= 11 && payload[0] === 0x4f && payload[1] === 0x70 && payload[2] === 0x75 && payload[3] === 0x73) {
      const ch = payload[9] || 2;
      const configs = [
        { codec: 'opus', sampleRate: SR, numberOfChannels: ch },
        { codec: 'opus', sampleRate: SR, numberOfChannels: ch, description: payload },
      ];
      for (const cfg of configs) {
        try {
          decoder.configure(cfg);
          configured = true;
          post('log', { message: '解码器已配置（worker，声道=' + ch + (cfg.description ? '，带 OpusHead' : '') + '）' });
          return;
        } catch (err) { /* 试下一种 */ }
      }
      post('log', { message: '配置失败（worker）' });
    }
    return;
  }
  if (d.type === 'init') {
    outPort = d.outPort || null;
    try {
      decoder = new AudioDecoder({
        output(audioData) {
          try {
            const numFrames = audioData.numberOfFrames;
            const chs = Math.min(audioData.numberOfChannels || 1, 2);
            const sampleRate = audioData.sampleRate || SR;
            if (numFrames <= 0) { audioData.close(); return; }
            const interleaved = new Float32Array(numFrames * 2);
            if (!audioData.format || String(audioData.format).indexOf('planar') !== -1) {
              const planes = [];
              for (let ch = 0; ch < chs; ch++) {
                planes.push(new Float32Array(numFrames));
                audioData.copyTo(planes[ch], { planeIndex: ch, formatOverride: 'f32-planar' });
              }
              for (let i = 0; i < numFrames; i++) {
                interleaved[i * 2] = planes[0][i];
                interleaved[i * 2 + 1] = chs > 1 ? planes[1][i] : planes[0][i];
              }
            } else {
              audioData.copyTo(interleaved, { planeIndex: 0 });
            }
            audioData.close();
            // 持续音频电平（500ms 窗口峰值）上报：主线程据此区分「手机在播」与「暂停/静止」
            let lp = 0;
            for (let i = 0; i < interleaved.length; i++) { const a = Math.abs(interleaved[i]); if (a > lp) lp = a; }
            levelPeak = Math.max(levelPeak, lp);
            if (++levelCount >= 25) { post('level', { peak: levelPeak }); levelPeak = 0; levelCount = 0; }
            decodeCount++;
            if (decodeCount === 1) post('log', { message: '首帧解码成功（worker 独立解码链路）' });
            if (!silenceChecked) {
              for (let i = 0; i < interleaved.length; i++) {
                const a = Math.abs(interleaved[i]);
                if (a > peak) peak = a;
              }
              if (decodeCount >= 150) {
                silenceChecked = true;
                post('silence', { silent: peak < 0.0001, peak: peak });
              }
            }
            // 直接推给 AudioWorklet 端口（MessageChannel），主线程零参与
            if (outPort) outPort.postMessage({ cmd: 'write', data: interleaved, frames: numFrames }, [interleaved.buffer]);
          } catch (err) {
            post('log', { message: '解码处理异常：' + err.message });
          }
        },
        error(e) { post('log', { message: '解码错误（worker）：' + e.message }); },
      });
      post('ready', { ok: true });
    } catch (err) {
      post('ready', { ok: false, message: err.message });
    }
    return;
  }
  if (d.type === 'chunk') {
    if (!decoder || !configured) {
      post('drop');
      return;
    }
    try {
      decoder.decode(new EncodedAudioChunk({
        type: 'key',
        timestamp: feedCount * FRAME_US,
        duration: FRAME_US,
        data: new Uint8Array(d.data),
      }));
      feedCount++;
    } catch (err) {
      post('log', { message: '送解码失败（worker）：' + err.message });
    }
    return;
  }
};
