(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const video = $('screen');
  const placeholder = $('placeholder');
  const screenWrap = $('screen-wrap');

  let ws = null;
  let pc = null;
  let localOfferSdp = null;
  let fpsTimer = null, fpsCount = 0, fpsTime = 0;

  function setState(text, live) {
    $('state-text').textContent = text;
    $('dot').classList.toggle('live', !!live);
  }
  function setWs(text, cls) {
    const el = $('info-ws');
    el.textContent = text;
    el.className = 'v' + (cls ? ' ' + cls : '');
  }
  function setCast(text, cls) {
    const el = $('info-cast');
    el.textContent = text;
    el.className = 'v' + (cls ? ' ' + cls : '');
  }

  /** 建立信令 WebSocket */
  function connectSignaling() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => { setWs('已连接', 'ok'); join(); };
    ws.onclose = () => { setWs('已断开', 'bad'); setCast('连接中断，正在重连…', 'bad'); setState('重连中', false); setTimeout(connectSignaling, 2000); };
    ws.onerror = () => setWs('异常', 'bad');
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      switch (msg.type) {
        case 'joined':
          setCast('已就位，等待手机', '');
          break;
        case 'waiting':
          setCast('已就位，等待手机', '');
          break;
        case 'peer-ready':
          setCast('手机已连接，协商中…', '');
          setState('协商中', false);
          break;
        case 'peer-left':
          cleanupStream('手机已断开投屏');
          setCast('手机已断开', '');
          break;
        case 'signal':
          handleSignal(msg.from, msg.data);
          break;
        case 'error':
          setCast(msg.message, 'bad');
          break;
      }
    };
  }

  function join() {
    const code = $('code').textContent.trim();
    if (!/^\d{6}$/.test(code)) return;
    send({ type: 'join', role: 'computer', code });
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function ensurePC() {
    if (pc) return pc;
    pc = new RTCPeerConnection({ iceServers: [] });
    pc.ontrack = (ev) => {
      video.srcObject = ev.streams[0];
      video.play().catch(() => {});
      screenWrap.classList.add('live');
      placeholder.style.display = 'none';
      $('btn-mute').disabled = false;
      $('btn-full').disabled = false;
      $('btn-stop').disabled = false;
      startFpsMeter();
      setCast('投屏中', 'ok');
      setState('投屏中', true);
      $('stat-text').textContent = '视频已接收';
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate) send({ type: 'signal', from: 'computer', data: { candidate: ev.candidate.toJSON() } });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        cleanupStream('连接中断');
        setCast('连接中断', 'bad');
        setState('中断', false);
      }
    };
    return pc;
  }

  function handleSignal(from, data) {
    const p = ensurePC();
    if (data.sdp) {
      if (data.sdp.type === 'offer') {
        p.setRemoteDescription(data.sdp)
          .then(() => p.createAnswer())
          .then((answer) => p.setLocalDescription(answer))
          .then(() => send({ type: 'signal', from: 'computer', data: { sdp: p.localDescription } }))
          .catch((err) => console.error('[offer] 处理失败:', err));
      } else if (data.sdp.type === 'answer' && localOfferSdp) {
        p.setRemoteDescription(data.sdp).catch((err) => console.error('[answer] 处理失败:', err));
        localOfferSdp = null;
      }
    } else if (data.candidate) {
      p.addIceCandidate(data.candidate).catch(() => {});
    }
  }

  function startFpsMeter() {
    stopFpsMeter();
    fpsCount = 0; fpsTime = performance.now();
    fpsTimer = setInterval(() => {
      const now = performance.now();
      const sec = (now - fpsTime) / 1000;
      const fps = sec > 0 ? Math.round(fpsCount / sec) : 0;
      $('info-fps').textContent = fps + ' fps';
      $('stat-text').textContent = video.videoWidth + '×' + video.videoHeight;
      fpsCount = 0; fpsTime = now;
    }, 1000);
    if (video.requestVideoFrameCallback) {
      const cb = () => { fpsCount++; video.requestVideoFrameCallback(cb); };
      video.requestVideoFrameCallback(cb);
    } else {
      // 退化方案：按播放时间粗估
      fpsTimer2 = setInterval(() => { fpsCount += 30; }, 1000);
    }
  }
  let fpsTimer2 = null;
  function stopFpsMeter() {
    if (fpsTimer) clearInterval(fpsTimer);
    if (fpsTimer2) clearInterval(fpsTimer2);
    fpsTimer = null; fpsTimer2 = null;
  }

  function cleanupStream(reason) {
    stopFpsMeter();
    try { if (video.srcObject) video.srcObject.getTracks().forEach((t) => t.stop()); } catch {}
    video.srcObject = null;
    screenWrap.classList.remove('live');
    placeholder.style.display = '';
    $('btn-mute').disabled = true;
    $('btn-full').disabled = true;
    $('btn-stop').disabled = true;
    $('video').muted = false;
    $('btn-mute').textContent = '🔊 声音';
    $('info-fps').textContent = '—';
    $('stat-text').textContent = '—';
    if (pc) { try { pc.close(); } catch {} pc = null; }
  }

  /* ---------- 按钮 ---------- */
  $('btn-stop').onclick = () => {
    send({ type: 'leave' });
    cleanupStream('已手动停止');
    setCast('已停止', '');
    setState('已停止', false);
  };
  $('btn-full').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else screenWrap.requestFullscreen().catch(() => {});
  };
  $('btn-mute').onclick = () => {
    // 无线投屏模式：控制 WebAudio 增益；WebRTC 模式：控制 video 元素
    const wirelessActive = document.getElementById('wl-canvas').style.display === 'block';
    if (wirelessActive) {
      window.__wlAudioToggle && window.__wlAudioToggle();
    } else {
      video.muted = !video.muted;
      $('btn-mute').textContent = video.muted ? '🔇 静音' : '🔊 声音';
    }
  };
  $('btn-refresh').onclick = () => initSession(true);

  let currentIp = null;

  /* ---------- 会话初始化 ---------- */
  async function initSession(showToast, ip) {
    try {
      const resp = await fetch('/api/session' + (ip ? '?ip=' + encodeURIComponent(ip) : ''));
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      currentIp = data.lanIP;
      $('code').textContent = data.code;
      $('qr').src = data.qr;
      $('info-url').textContent = data.castUrl;
      $('stat-text').textContent = '投屏码已生成';
      setCast('等待连接', '');
      renderAddrChips(data.lanIPs || []);
      if (showToast) setCast('已重新生成投屏码', '');
      // 会话变化后重新加入信令
      if (ws && ws.readyState === WebSocket.OPEN) join();
    } catch (err) {
      setCast('获取投屏码失败：' + err.message, 'bad');
    }
  }

  /** 渲染本机所有可用地址芯片，点击可切换二维码中的地址 */
  function renderAddrChips(ips) {
    const box = $('addr-list');
    box.innerHTML = '';
    if (!ips.length) {
      box.innerHTML = '<span class="addr-hint">未检测到可用地址</span>';
      return;
    }
    ips.forEach((ip) => {
      const chip = document.createElement('span');
      chip.className = 'addr-chip' + (ip === currentIp ? ' active' : '');
      chip.textContent = ip;
      chip.title = '使用 ' + ip + ' 生成投屏二维码（手机与本机需能互相访问）';
      chip.onclick = () => initSession(true, ip);
      box.appendChild(chip);
    });
  }

  /* ---------- 左栏画面需要同时承载 <video>（WebRTC）与 <canvas>（WebCodecs） ---------- */
  const canvas = document.createElement('canvas');
  canvas.id = 'wl-canvas';
  canvas.style.cssText = 'width:100%;height:100%;object-fit:contain;display:none;background:#101318';
  document.getElementById('screen-wrap').appendChild(canvas);

  initSession(false);
  connectSignaling();

  /* ================================================================
   * 无线投屏通道（Android：ADB + scrcpy → H.264 裸流 → WebCodecs 解码）
   * ================================================================ */
  (function wirelessCast() {
    const $ = (id) => document.getElementById(id);
    const statusEl = $('wl-status');
    const logEl = $('wl-log');
    const canvasEl = $('wl-canvas');
    const videoEl = $('screen');
    const placeholder = $('placeholder');

    let ws = null;
    let decoder = null;
    let keyChunkNeeded = true;   // 等待关键帧
    let pending = [];            // 解码器就绪前缓存的数据
    let frameCount = 0, fpsTime = 0, fpsTimer = null;
    let wsState = 'idle';
    let autoConnectTried = false;  // 每次页面会话只自动连接一次，避免死循环打扰

    /* ---------- Tab 切换 ---------- */
    const tabs = { 'tab-scan': 'scan-body', 'tab-wireless': 'wireless-body' };
    Object.keys(tabs).forEach((tabId) => {
      $(tabId).onclick = () => {
        Object.keys(tabs).forEach((t) => {
          $(t).classList.toggle('active', t === tabId);
          $(tabs[t]).classList.toggle('show', t === tabId);
          $(tabs[t]).style.display = t === tabId ? '' : 'none';
        });
      };
    });

    function log(text) {
      const line = document.createElement('div');
      line.textContent = text;
      logEl.appendChild(line);
      while (logEl.children.length > 100) logEl.removeChild(logEl.firstChild);
      logEl.scrollTop = logEl.scrollHeight;
    }

    function setStatus(text) {
      statusEl.textContent = text;
    }

    function updateButtons(state) {
      wsState = state;
      $('wl-btn-pair').disabled = state === 'streaming' || state === 'connecting' || state === 'pairing';
      $('wl-btn-connect').disabled = state === 'streaming' || state === 'connecting' || state === 'pairing';
      $('wl-btn-qr-pair').disabled = state === 'streaming' || state === 'connecting' || state === 'pairing';
      $('wl-btn-start').disabled = !(state === 'ready' || state === 'idle');
      $('wl-btn-stop').disabled = state !== 'streaming';
      if (state === 'streaming') hideQrZone();
    }

    function showCanvas() {
      canvasEl.style.display = 'block';
      videoEl.style.display = 'none';
      placeholder.style.display = 'none';
      document.getElementById('screen-wrap').classList.add('live');
      document.getElementById('btn-full').disabled = false;
      document.getElementById('btn-stop').disabled = false;
    }

    function hideCanvas() {
      canvasEl.style.display = 'none';
      videoEl.style.display = '';
      document.getElementById('screen-wrap').classList.remove('live');
      placeholder.style.display = '';
      document.getElementById('btn-mute').disabled = true;
      document.getElementById('btn-full').disabled = true;
      document.getElementById('btn-stop').disabled = true;
    }

    /* ---------- H.264 Annex-B 码流状态机 ----------
     * 服务端转发的是 Annex-B 裸流（00 00 01 起始码）。
     * 策略：扫描完整 NAL → SPS/PPS 缓存；IDR 关键帧 = SPS+PPS+IDR 拼接；
     * 普通 slice NAL 作为 delta 帧送解码；等待关键帧期间丢弃 delta。 */
    let streamBuf = new Uint8Array(0);
    let sps = null;
    let pps = null;
    let rotationPending = false;  // 检测到 SPS 变化（旋转/分辨率切换），待下个关键帧重置解码器
    let decoderRecoveryTimer = null; // 解码错误后的恢复任务（防错误风暴重复重建）

    /** 扫描 buffer 中的完整 NAL（无后续起始码的尾部视为未完成，留到下一包） */
    function scanCompleteNals(buf) {
      const nals = [];
      let i = 0;
      let consumed = 0;
      while (i < buf.length - 3) {
        if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
          const hdr = i + 3;
          let j = hdr;
          let next = -1;
          while (j < buf.length - 2) {
            if (buf[j] === 0 && buf[j + 1] === 0 && buf[j + 2] === 1) { next = j; break; }
            j++;
          }
          if (next === -1) break; // 本 NAL 可能跨包，留待拼接后处理
          nals.push({ start: i, header: hdr, end: next, type: buf[hdr] & 0x1f });
          consumed = next;
          i = hdr;
        } else {
          i++;
        }
      }
      return { nals, consumed };
    }

    function onVideoData(chunk) {
      lastVideoDataTime = performance.now(); // 看门狗：区分「没数据」与「有数据不出帧」
      videoBytesWindow += chunk.byteLength || 0; // 指标面板：到达码率统计
      const incoming = new Uint8Array(chunk);
      const merged = new Uint8Array(streamBuf.length + incoming.length);
      merged.set(streamBuf, 0);
      merged.set(incoming, streamBuf.length);
      const { nals, consumed } = scanCompleteNals(merged);
      streamBuf = merged.slice(consumed);

      for (const nal of nals) {
        const data = merged.slice(nal.start, nal.end);
        if (nal.type === 7) {
          if (sps && !bytesEqual(sps, data)) {
            // 竖屏⇄横屏旋转：分辨率变化带来新 SPS。解码器对带内分辨率切换的兼容性不可靠，
            // 标记后在下个关键帧处重置（新 SPS/PPS+IDR 干净起播），避免画面永久冻结
            rotationPending = true;
            log('[解码] 检测到分辨率变化（旋转屏幕），将在下个关键帧重置解码器');
          }
          sps = data; continue;
        }
        if (nal.type === 8) { pps = data; continue; }
        if (nal.type !== 1 && nal.type !== 5) continue; // 跳过 SEI/AUD 等
        if (nal.type === 5) {
          // 关键帧：SPS+PPS+IDR 一起送（Annex-B in-band，Chrome 可自动解析）
          const parts = [];
          if (sps) parts.push(sps);
          if (pps) parts.push(pps);
          parts.push(data);
          keyChunkNeeded = false;
          if (rotationPending && decoder && decoder.state !== 'closed') {
            // 旋转重置：清掉旧参考帧/队列，用新分辨率的 SPS/PPS+IDR 重新起播
            try { decoder.reset(); } catch {}
            videoBacklogDrop = false;
            rotationPending = false;
            log('[解码] 旋转完成，已按新分辨率重置解码器');
          }
          feedDecoder(concat(parts), true);
        } else if (!keyChunkNeeded) {
          feedDecoder(data, false);
        }
      }
    }

    function concat(parts) {
      let size = 0;
      for (const p of parts) size += p.length;
      const out = new Uint8Array(size);
      let off = 0;
      for (const p of parts) { out.set(p, off); off += p.length; }
      return out;
    }

    /** 从 Annex-B SPS 提取真实 profile/constraint/level → avc1.PPCCLL（供解码器按实际规格配置） */
    function codecFromSps(sps) {
      const h = (b) => b.toString(16).padStart(2, '0');
      for (let i = 0; i + 6 < sps.length; i++) {
        if (sps[i] === 0 && sps[i + 1] === 0 && sps[i + 2] === 1 && (sps[i + 3] & 0x1f) === 7) {
          return 'avc1.' + h(sps[i + 4]) + h(sps[i + 5]) + h(sps[i + 6]);
        }
      }
      return null;
    }

    // ---- 视频流畅性与音画同步 ----
    // 1) 解码积压控制：decodeQueueSize 超阈值即丢弃后续 delta 帧直到下一个关键帧（reset 后重同步）
    // 2) rAF 垂直同步呈现 + 到达年龄对齐：解码帧入队，按「到达年龄 ≈ 音频播放水位」挑帧上屏，
    //    视频的到达→呈现延迟与音频的到达→播放延迟对齐（口型同步）；帧到达抖动被队列吸收
    let frameQueue = [];          // 待呈现帧队列 [{frame, t}]，t = 解码输出时刻
    let paintScheduled = false;   // 是否已排队一次上屏（rAF 或定时器）
    let videoBacklogDrop = false; // 正在因积压丢帧（直到下个关键帧）
    let videoBacklogEvents = 0;   // 累计发生积压丢帧的次数（诊断用）
    let paintTimer = null;        // 页面不可见时 rAF 停摆的定时器兑底
    let lastPaintTime = 0;        // 最近一次上屏时刻（看门狗①）
    let lastVideoDataTime = 0;    // 最近一次收到视频数据时刻（看门狗②）
    let videoBytesWindow = 0;     // 本统计窗口收到的视频字节数（指标面板：到达码率）
    let rttMs = -1;               // WS 往返延迟（指标面板，每秒探测一次）
    let streamInfo = null;        // 服务端流信息（链路类型/码率/帧率/编码器/熄屏，指标面板）
    let audioBufferMs = 0;        // 环形缓冲水位（worklet 每秒上报，音画同步与面板共用）
    let decodedWindow = 0;        // 本窗口解码输出帧数（指标面板：到达帧率，与呈现帧率分离）
    let queueDrops = 0;           // 本窗口呈现队列丢弃帧数（头部过时 + 容量溢出）
    let lastAudioDataTime = 0;    // 最近一次收到音频数据时刻（看门狗②：音频活=采集进程活）
    let lastRebuildAt = 0;        // 最近一次强制重建解码器时刻（8s 门限防连环重建）
    let lastStallNotify = 0;      // 最近一次向服务端上报视频流停滞时刻（45s 门限）
    let stallNotifyTimes = [];    // 10 分钟窗口内的上报时刻（≥5 次熔断：手机端采集正被系统反复中断时，
                                  // 反复重建投影会话会刺激系统进一步限流，越重启越糟）
    let lastCapHintAt = 0;        // 最近一次「已熔断」提示时刻
    let audioCorrectTimes = [];   // 音频校正时刻（10s 窗口：频繁校正 = 链路抖动大，校正反而每秒切音频）
    let audioCorrectEnabled = true; // 音频深水位校正开关（链路抖动风暴时自动关闭，接受高延迟换连贯）
    let stallEscalation = 0;      // 停摆自愈升级级别：1=已重建解码器 2=已重启会话（≥2 且仍停摆 → 刷新页面）
    let lastReloadAt = 0;         // 最近一次自刷新页面时刻（Date.now 基准，5 分钟限频防刷新循环）
    try { lastReloadAt = Number(sessionStorage.getItem('wl-auto-reload-at') || 0); } catch {}

    // 音画同步目标延迟：固定 150ms，与音频环形缓冲的目标水位对齐。
    // 注意：绝不把目标绑到实时水位——水位会被网络突发顶高，而呈现队列容量有限，
    // 绑定会导致「头部帧永远到不了龄就被挤掉」的呈现死锁（v0.7.2-0.7.4 教训：
    // 到达 0/呈现 0 但码率正常、解码池被滞留帧耗尽）。音频侧由 worklet 的
    // 深水位校正把水位收敛在 ~200ms，两侧误差可控制在 ±100ms 内

    function schedulePaint() {
      if (paintScheduled) return;
      paintScheduled = true;
      // 页面被遮挡/切后台时 rAF 可能完全停摆（音频走 Worker 不受影响）——定时器兑底继续上屏最新帧；
      // 可见时用 rAF 与显示刷新周期对齐（v0.6.6：单一排队标记，杜绝 rAF 挂起后标记永真的渲染死锁）
      if (document.hidden) paintTimer = setTimeout(paintFrame, 250);
      else requestAnimationFrame(paintFrame);
    }

    function drawFrame(frame) {
      try {
        const c2d = canvasEl.getContext('2d');
        if (canvasEl.width !== frame.displayWidth || canvasEl.height !== frame.displayHeight) {
          canvasEl.width = frame.displayWidth;
          canvasEl.height = frame.displayHeight;
        }
        c2d.drawImage(frame, 0, 0);
      } catch (e) {
        log('[解码] 绘制异常：' + e.message);
      }
    }

    function paintFrame() {
      paintScheduled = false;
      stallEscalation = 0; // 成功上屏 = 恢复健康，自愈升级级别归零
      if (paintTimer) { clearTimeout(paintTimer); paintTimer = null; }
      if (!frameQueue.length) return;
      if (document.hidden) {
        // 不可见：只保最新帧（节流环境省资源，回前台时立刻有画面）
        const newest = frameQueue[frameQueue.length - 1];
        for (const it of frameQueue) { if (it !== newest) { try { it.frame.close(); } catch {} } }
        frameQueue = [newest];
        drawFrame(newest.frame);
        try { newest.frame.close(); } catch {}
        lastPaintTime = performance.now();
        frameCount++;
        showCanvas();
        hintUpscale(canvasEl);
        return;
      }
      const now = performance.now();
      // FIFO 呈现 + 固定 150ms 同步延迟（v0.7.5）：解码帧在队列中等到龄后按序上屏，
      // 与音频环形缓冲的目标水位对齐；过时头部帧（>300ms）直接丢弃。
      // 不要把目标绑到实时水位：水位被网络突发顶高而队列容量有限，绑定会造呈现死锁
      // （v0.7.2-0.7.4 教训：到达 0/呈现 0 卡死循环）
      while (frameQueue.length > 1 && now - frameQueue[0].t > 300) {
        const stale = frameQueue.shift();
        queueDrops++;
        try { stale.frame.close(); } catch {}
      }
      const head = frameQueue[0];
      if (now - head.t < 110) {
        // 首帧还没到龄（110ms = 150ms 目标 - 40ms 容差）：按到龄时间排队下一次上屏
        const wait = Math.max(5, Math.min(100, 110 - (now - head.t)));
        paintScheduled = true;
        paintTimer = setTimeout(paintFrame, wait);
        return;
      }
      frameQueue.shift();
      drawFrame(head.frame);
      try { head.frame.close(); } catch {}
      lastPaintTime = now;
      frameCount++;
      showCanvas();
      hintUpscale(canvasEl);
    }

    function feedDecoder(data, isKey) {
      if (!decoder || decoder.state === 'closed') return;
      // 积压检测（阈值 8 帧 ≈ 130ms@60fps）：超限即进入丢帧模式
      if (!videoBacklogDrop && decoder.decodeQueueSize > 8) {
        videoBacklogDrop = true;
        videoBacklogEvents++;
        log('[解码] 解码积压（队列 ' + decoder.decodeQueueSize + ' 帧），丢帧至下个关键帧重同步');
      }
      if (videoBacklogDrop) {
        if (!isKey) return; // 积压期间只等关键帧
        try { decoder.reset(); } catch {} // 清空队列与旧参考帧，配合 in-band SPS/PPS 重新起播
        videoBacklogDrop = false;
      }
      // reset/重建后解码器可能回到未配置态：配置后再送帧（否则 decode 抛 InvalidStateError）
      if (decoder.state === 'unconfigured') {
        try { decoder.configure({ codec: 'avc1.42E01F' }); configuredCodec = 'avc1.42E01F'; } catch (e) { return; }
      }
      // v0.6.6：按 SPS 的真实 profile/level 配置——42E01F（Baseline L3.1）低于 1080p60 所需规格，
      // 部分硬件解码器对超规格码流会静默卡死（只积压不出帧、无错误回调），用真实规格配置是根治
      if (isKey && sps) {
        const realCodec = codecFromSps(sps);
        if (realCodec && configuredCodec !== realCodec) {
          try {
            decoder.configure({ codec: realCodec });
            configuredCodec = realCodec;
            log('[解码] 已按码流实际规格配置解码器（' + realCodec + '）');
          } catch (e) { /* 用原配置继续 */ }
        }
      }
      try {
        decoder.decode(new EncodedVideoChunk({
          type: isKey ? 'key' : 'delta',
          timestamp: performance.now() * 1000,
          data,
        }));
      } catch (e) {
        log('[解码] 丢帧：' + e.message);
      }
    }

    function bytesEqual(a, b) {
      if (a === b) return true;
      if (!a || !b || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    }

    /* 解码错误自动恢复：软错误用 reset 清掉错误态，致命错误（closed 态）整体重建。
     * 两者都丢掉旧参考帧等下一个关键帧干净起播——旋转/分辨率切换时关键帧是立即送到的，
     * 恢复几乎是瞬时；普通场景下 scrcpy 编码器默认约 10s 一个 I 帧，最多等这么久。
     * 音频链路独立于视频解码器，恢复期间声音不受影响。 */
    function recoverDecoder() {
      if (decoderRecoveryTimer) return; // 错误风暴时只调度一次
      decoderRecoveryTimer = setTimeout(() => {
        decoderRecoveryTimer = null;
        if (!decoder) return;
        try { if (decoder.state !== 'closed') decoder.reset(); } catch {}
        if (decoder.state === 'closed') {
          try { decoder.close(); } catch {}
          decoder = null;
          configured = false;
          configuredCodec = null;
          ensureDecoder();
          configureIfNeeded();
        }
        keyChunkNeeded = true;
        videoBacklogDrop = false;
        lastRebuildAt = performance.now();
        log('[解码] 解码器已复位，等待下一个关键帧恢复画面（音频不受影响）');
      }, 300);
    }

    /* 看门狗①强制重建：视频数据仍在到达但持续不出帧（硬件解码器停摆、无错误回调的黑盒场景）。
     * 整体 close 后重建解码器并等下一个关键帧；任何解码侧停摆都在数秒内自愈。 */
    function forceDecoderRebuild(now) {
      lastRebuildAt = now || performance.now();
      log('[解码] 画面停摆但数据仍在到达，强制重建解码器（音频不受影响）');
      if (decoderRecoveryTimer) { clearTimeout(decoderRecoveryTimer); decoderRecoveryTimer = null; }
      try { if (decoder) decoder.close(); } catch {}
      decoder = null;
      configured = false;
      configuredCodec = null;
      keyChunkNeeded = true;
      videoBacklogDrop = false;
      rotationPending = false;
      for (const it of frameQueue) { try { it.frame.close(); } catch {} }
      frameQueue = [];
      ensureDecoder();
      configureIfNeeded();
      lastPaintTime = performance.now(); // 给下一个关键帧留宽限（连环重建由 lastRebuildAt 8s 门限兑底）
    }

    /* ---------- 清晰度自检 ----------
     * 画面是按编码分辨率做的位图，铺满窗口时由浏览器放大（双线性），
     * 源宽明显小于显示宽时会明显发糊——此时唯一的解法是提高采集分辨率（原生档），
     * 调码率/调滤镜都补不回不存在的像素。 */
    let upscaleHinted = false;
    function hintUpscale(el) {
      if (upscaleHinted) return;
      const srcW = el.width;
      const dispW = el.clientWidth * (window.devicePixelRatio || 1);
      if (!srcW || !dispW) return;
      if (dispW / srcW >= 1.25) {
        upscaleHinted = true;
        const q = document.getElementById('wl-quality');
        if (q && q.value !== 'native') {
          log('[画质] 源画面 ' + srcW + '×' + el.height + '，显示宽约 ' + Math.round(dispW) +
            '（放大 ' + (dispW / srcW).toFixed(1) + ' 倍）。若觉得糊，停止投屏后把画质切到「原生」再开始');
        }
      }
    }
    window.addEventListener('resize', () => { upscaleHinted = false; if (canvasEl) hintUpscale(canvasEl); });
    // 页面重新可见：立刻排队一次上屏（后台期间 rAF 停摆，只靠节流定时器保底最新帧）
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && frameQueue.length) schedulePaint();
    });

    /* ---------- WebCodecs 解码器 ---------- */
    function ensureDecoder() {
      if (decoder) return;
      if (typeof VideoDecoder === 'undefined') {
        log('[解码] 当前浏览器不支持 WebCodecs，请使用 Chrome / Edge 打开接收页');
        return;
      }
      decoder = new VideoDecoder({
        output(frame) {
          // rAF 呈现：暂存最新帧（被更新的帧立即关闭，不留积压），vsync 时统一上屏
          // 音画同步呈现（v0.7.2）：解码帧入队，按到达年龄 ≈ 音频水位挑帧上屏；
          // 队列过深（>16，低到达帧率下覆盖更长的目标延迟）丢最旧，防延迟累积与解码反压
          decodedWindow++;
          frameQueue.push({ frame, t: performance.now() });
          while (frameQueue.length > 16) { const old = frameQueue.shift(); queueDrops++; try { old.frame.close(); } catch {} }
          schedulePaint();
        },
        error(e) {
          log('[解码] 错误：' + e.message);
          recoverDecoder();
        },
      });
      log('[解码] 使用 WebCodecs 硬件/软件解码');
    }

    /** 重置解码会话（开始新一轮投屏 / 停止时调用） */
    function resetDecoder() {
      if (decoder && decoder.state !== 'closed') {
        try { decoder.reset(); } catch {}
      }
      configured = false;
      keyChunkNeeded = true;
      streamBuf = new Uint8Array(0);
      sps = null;
      pps = null;
      rotationPending = false;
      videoBacklogDrop = false;
      configuredCodec = null;
      if (decoderRecoveryTimer) { clearTimeout(decoderRecoveryTimer); decoderRecoveryTimer = null; }
      if (paintTimer) { clearTimeout(paintTimer); paintTimer = null; }
      paintScheduled = false;
      lastPaintTime = performance.now();
      lastVideoDataTime = 0;
      lastRebuildAt = 0;
      lastStallNotify = 0;
      for (const it of frameQueue) { try { it.frame.close(); } catch {} }
      frameQueue = [];
    }

    /* ---------- 音频（scrcpy Opus 48kHz 双声道 → WebCodecs → WebAudio） ----------
     * 手机声音在电脑端播放，不依赖手机扬声器。声音开关用现有「🔊 声音」按钮控制。 */
    let audioDecoder = null;
    let audioCtx = null;
    let audioGain = null;       // GainNode：静音/取消静音
    let audioMuted = false;
    let audioConfigured = false;
    let audioChannels = 2;
    let audioDecodeCount = 0;   // 已解码帧数（诊断用）
    let audioPeak = 0;          // 静音检测：观测到的最大采样幅值
    let audioSilenceCheck = null; // null=检测中，true/false=结论
    let audioUnconfiguredDrops = 0; // 因未收到配置包而被丢弃的音频包数
    let audioFeedCount = 0;      // 已送入解码器的 chunk 数（时间戳基准，须与输出解耦、严格递增）

    // 音频诊断回报：同步到服务端文件日志（logs/localcast.log），出问题时无需用户贴日志
    function reportAudioState(message) {
      log('[音频] ' + message);
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'client-log', message: 'audio: ' + message })); } catch {}
      }
    }

    // ---- 手机端「正在出声」检测：解码电平滚动窗口（约 500ms）峰值 ----
    // 用于区分「视频停滞」与「手机端暂停/画面静止」（后者 scrcpy 不产帧是正常现象，不能当停滞重启）
    let audioLivePeak = 0;      // 最近窗口峰值（f32 线性幅度）
    let audioLivePeakAt = 0;    // 窗口提交时刻
    let audioLiveWinPeak = 0;
    let audioLiveWinFrames = 0;
    let lastIdleHintAt = 0;     // 最近一次「待机」提示时刻（10s 限频）
    function noteAudioLevel(peak) {
      audioLiveWinPeak = Math.max(audioLiveWinPeak, peak || 0);
      if (++audioLiveWinFrames >= 25) { // 25 帧 × 20ms = 500ms 窗口
        audioLivePeak = audioLiveWinPeak;
        audioLivePeakAt = performance.now();
        audioLiveWinPeak = 0;
        audioLiveWinFrames = 0;
      }
    }
    const SAMPLE_RATE = 48000;
    const FRAME_DURATION_US = 20000; // scrcpy Opus 帧长 20ms
    // ---- 播放排程参数（AudioWorklet 环形缓冲）----
    const AUDIO_RING_SECONDS = 1.0;   // 环形缓冲容量 1 秒
    const AUDIO_START_WATERMARK = 0.15; // 起播水位：缓冲积累到 150ms 才开始播放
    // AudioWorklet 处理器：单一播放时钟连续消费环形缓冲，帧边界采样永不间断
        let audioWorkletNode = null;  // AudioWorkletNode（环形缓冲播放）
    let audioWorkletReady = false;
    let audioPlaybackTime = 0;    // 回退逐帧排程模式的播放时钟（主路径为环形缓冲，不使用）

    // ---- 音频解码 Worker：解码与搬运全部离线主线程（窗口被遮挡/降级时主线程被节流，
    //      解码卡顿环形缓冲断粮 → 断续声；Worker 不受渲染优先级影响）----
        let audioWorker = null;      // 音频解码 Worker
    let audioWorkerReady = false; // worker 内 AudioDecoder 可用
    let audioWorkerDrops = 0;     // worker 侧因未配置丢弃的帧数（诊断用）
    let workletBound = false;     // worklet 是否已接住转移进来的 PCM 端口（握手确认）

    async function ensureAudioCtx() {
      // 每次投屏重建 AudioContext：切换输出设备（如插拔耳机）后旧上下文可能失效
      if (audioCtx && audioCtx.state !== 'closed') {
        try { await audioCtx.close(); } catch {}
      }
      audioCtx = new AudioContext();
      audioGain = audioCtx.createGain();
      audioGain.gain.value = audioMuted ? 0 : 1;
      audioGain.connect(audioCtx.destination);
      // 加载 AudioWorklet 环形缓冲模块（连续播放时钟，消除帧边界杂音）
      audioWorkletNode = null;
      audioWorkletReady = false;
      if (audioWorker) {
        try { audioWorker.terminate(); } catch {}
        audioWorker = null;
      }
      audioWorkerReady = false;
      audioWorkerDrops = 0;
      workletBound = false;
      try {
        await audioCtx.audioWorklet.addModule('/js/audio-worklet.js');
        audioWorkletNode = new AudioWorkletNode(audioCtx, 'ring-buffer-processor', {
          numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
        });
        audioWorkletNode.port.onmessage = (e) => {
          const d = e.data || {};
          if (d.event === 'start') reportAudioState('环形缓冲起播（水位 150ms）');
          else if (d.event === 'underrun') reportAudioState('缓冲欠载一次（播放时钟保持连续，已自动接上）');
          else if (d.event === 'buffer') audioBufferMs = d.ms || 0; // 每秒水位上报：指标面板 + 音画同步目标
          else if (d.event === 'buffer-correct') {
            audioCorrectTimes.push(performance.now());
            audioCorrectTimes = audioCorrectTimes.filter((t) => performance.now() - t < 10000);
            if (audioCorrectTimes.length >= 3 && audioCorrectEnabled) {
              // 校正风暴：水位反复冲高说明链路在批量投递（手机 Wi-Fi 省电模式典型行为），
              // 每秒校正等于每秒切掉一段音频——停掉校正接受较高延迟换取连贯，并建议插 USB
              audioCorrectEnabled = false;
              try { audioWorkletNode && audioWorkletNode.port.postMessage({ cmd: 'set-correction', enabled: false }); } catch {}
              reportAudioState('⚠ 音频校正过于频繁（链路抖动大，疑似手机 Wi-Fi 省电批量投递）：已停止校正，接受较高延迟换取连贯。建议插 USB 线彻底解决');
            } else if (audioCorrectEnabled) {
              reportAudioState('音频延迟校正：丢弃 ' + (d.droppedMs || 0) + 'ms 旧数据以恢复同步（水位曾超 350ms，会有一次轻微跳跃）');
            }
          }
          else if (d.event === 'bind-ack') workletBound = true;
        };
        audioWorkletNode.connect(audioGain);
        audioWorkletReady = true;
      } catch (e) {
        reportAudioState('AudioWorklet 不可用（' + e.message + '），回退逐帧排程模式');
      }
      // ---- 音频解码 Worker：解码在独立线程，主线程只转发原始包（后台/被遮挡时不断粮）----
      if (audioWorkletReady && audioWorkletNode && typeof Worker !== 'undefined') {
        try {
          audioWorker = new Worker('/js/audio-worker.js');
          // MessageChannel：worker（port2）→ worklet（port1 转移进 AudioWorkletNode）
          // PCM 从 worker 直达环形缓冲，主线程零参与（后台播放不卡顿的关键）
          const channel = new MessageChannel();
          audioWorkletNode.port.postMessage({ cmd: 'bind-port', port: channel.port1 }, [channel.port1]);
          // 端口没接上 → worker 的 PCM 无处可去，会变成「出声正常但一片安静」的假象，
          // 宁可回退主线程解码（可能断续，但至少有声）
          // 注意计时只在音频线程跑起来之后才计（ctx 暂挂时 worklet 消息队列不处理，不能据此判死刑）
          let bindChecks = 0;
          const bindTimer = setInterval(() => {
            if (workletBound || !audioWorker) { clearInterval(bindTimer); return; }
            if (audioCtx && audioCtx.state !== 'running') return;
            if (++bindChecks >= 3) {
              clearInterval(bindTimer);
              reportAudioState('PCM 端口未在 AudioWorklet 中生效，回退主线程解码（后台播放可能仍有断续）');
              try { audioWorker.terminate(); } catch {}
              audioWorker = null;
              audioWorkerReady = false;
            }
          }, 600);
          audioWorker.onmessage = (ev) => {
            const d = ev.data || {};
            if (d.type === 'ready') {
              audioWorkerReady = !!d.ok;
              if (d.ok) {
                // 配置包可能早于 worker 就绪到达（走了主线程路径只缓存未转发）→ 此处补发，
                // 否则 worker 一直处于未配置状态，数据全丢、无声
                if (audioConfigCache && audioConfigCache.length) {
                  const cfgCopy = audioConfigCache.slice();
                  audioWorker.postMessage({ type: 'config', data: cfgCopy.buffer }, [cfgCopy.buffer]);
                }
              } else {
                reportAudioState('Worker 内解码器不可用（' + (d.message || '') + '），回退主线程解码');
              }
            } else if (d.type === 'drop') {
              audioWorkerDrops++;
              if (audioWorkerDrops === 50) {
                reportAudioState('⚠ Worker 未收到配置包，音频已丢弃 50 帧（等待配置补发）');
              }
            } else if (d.type === 'log') {
              reportAudioState(d.message || '');
            } else if (d.type === 'level') {
              noteAudioLevel(d.peak || 0); // worker 电平上报 → 待机/停滞判别
            } else if (d.type === 'silence') {
              reportAudioState(d.silent
                ? '静音判定：手机采集到的是无声数据（3 秒峰值=' + Number(d.peak).toFixed(5) + '）。手机端问题：媒体音量为 0 或该 App 禁止录音'
                : '信号判定：音频信号正常（3 秒峰值=' + Number(d.peak).toFixed(3) + '）。若听不到请检查电脑音量/输出设备/浏览器标签页是否被系统静音');
            }
          };
          // init 时把通道另一端交给 worker：worker 解码出的 PCM 从这里直发 worklet
          audioWorker.postMessage({ type: 'init', outPort: channel.port2 }, [channel.port2]);
        } catch (e) {
          reportAudioState('音频 Worker 创建失败（' + e.message + '），回退主线程解码');
          audioWorker = null;
          audioWorkerReady = false;
        }
      }
      if (audioCtx.state === 'suspended') {
        try {
          await audioCtx.resume();
        } catch {}
        if (audioCtx.state === 'suspended') {
          reportAudioState('⚠ 浏览器暂挂了音频输出（自动播放策略），点击页面任意位置即可恢复');
        }
      }
      reportAudioState('输出设备就绪（' + audioCtx.sampleRate + 'Hz，AudioContext=' + audioCtx.state +
        (audioWorkletReady ? '，环形缓冲' : '，逐帧排程') + '）');
      // ctx/worklet 就绪后补配置：配置包可能在 addModule 完成前到达（解码器未配置，数据全丢）
      applyAudioConfigFromCache();
    }

    async function setupAudio() {
      if (audioDecoder && audioDecoder.state !== 'closed') return;
      if (typeof AudioDecoder === 'undefined') {
        reportAudioState('当前浏览器不支持 WebCodecs 音频解码，声音不可用（画面正常）');
        return;
      }
      audioConfigured = false;
      audioConfigCache = null;
      audioDecodeCount = 0;
      audioFeedCount = 0;
      audioPeak = 0;
      audioSilenceCheck = null;
      audioUnconfiguredDrops = 0;
      audioPlaybackTime = 0;
      // 先等输出环境（AudioContext + AudioWorklet 模块）就绪再建解码器：
      // 配置包在投屏开始瞬间就广播，若解码器先于 ctx 建好、或晚于数据到达，都会丢数据（v0.5.0 回归的教训）
      try { await ensureAudioCtx(); } catch (e) {
        reportAudioState('输出环境初始化失败：' + e.message);
      }
      audioDecoder = new AudioDecoder({
        output(audioData) {
          try {
            const numFrames = audioData.numberOfFrames;
            const chs = Math.min(audioData.numberOfChannels || 1, 2);
            const sampleRate = audioData.sampleRate || SAMPLE_RATE;
            if (numFrames <= 0 || !audioCtx || !audioGain) { audioData.close(); return; }
            // 关键：AudioData 没有 getChannelData()（那是 AudioBuffer 的 API），
            // 必须用 copyTo(plane, {planeIndex, formatOverride}) 取 f32-planar 平面数据
            // 统一取成交错 f32 立体声（worklet 环形缓冲直接吃；回退模式再拆进 AudioBuffer）
            const interleaved = new Float32Array(numFrames * chs);
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
            // ---- 播放路径 A：AudioWorklet 环形缓冲（首选：单一连续播放时钟，帧边界零杂音）----
            if (audioWorkletReady && audioWorkletNode && sampleRate === audioCtx.sampleRate) {
              audioWorkletNode.port.postMessage(
                { cmd: 'write', data: interleaved, frames: numFrames },
                [interleaved.buffer] // 转移所有权，零拷贝
              );
              let fp = 0;
              for (let i = 0; i < interleaved.length; i++) { const a = Math.abs(interleaved[i]); if (a > fp) fp = a; }
              noteAudioLevel(fp);
              audioDecodeCount++;
              if (audioDecodeCount === 1) {
                reportAudioState('首帧解码成功，写入环形缓冲（AudioContext=' + audioCtx.state + '，增益=' + (audioMuted ? '静音' : '开') + '）');
              }
              if (audioSilenceCheck === null) {
                for (let i = 0; i < interleaved.length; i++) {
                  const a = Math.abs(interleaved[i]);
                  if (a > audioPeak) audioPeak = a;
                }
                if (audioDecodeCount >= 150) {
                  audioSilenceCheck = audioPeak < 0.0001;
                  reportAudioState(audioSilenceCheck
                    ? '静音判定：手机采集到的是无声数据（3 秒峰值=' + audioPeak.toFixed(5) + '）。手机端问题：媒体音量为 0 或该 App 禁止录音'
                    : '信号判定：音频信号正常（3 秒峰值=' + audioPeak.toFixed(3) + '）。若听不到请检查电脑音量/输出设备/浏览器标签页是否被系统静音');
                }
              }
              return;
            }
            // ---- 播放路径 B：逐帧排程回退（AudioWorklet 不可用或采样率不匹配时）----
            const audioBuf = audioCtx.createBuffer(2, numFrames, sampleRate);
            audioBuf.copyToChannel(interleaved.subarray(0, numFrames), 0);
            if (chs > 1) audioBuf.copyToChannel(interleaved.subarray(numFrames, numFrames * 2), 1);
            else audioBuf.copyToChannel(interleaved.subarray(0, numFrames), 1);
            const src = audioCtx.createBufferSource();
            src.buffer = audioBuf;
            src.connect(audioGain);
            const now = audioCtx.currentTime;
            const dur = numFrames / sampleRate;
            // 回退模式简单排程：落后即重置，超前 300ms 丢帧
            if (audioPlaybackTime < now) audioPlaybackTime = now + 0.10;
            else if (audioPlaybackTime - now > 0.30) { audioDecodeCount++; return; }
            src.start(audioPlaybackTime);
            audioPlaybackTime += dur;
            let fp = 0;
            for (let i = 0; i < interleaved.length; i++) { const a = Math.abs(interleaved[i]); if (a > fp) fp = a; }
            noteAudioLevel(fp);
            audioDecodeCount++;
            if (audioDecodeCount === 1) {
              reportAudioState('首帧解码成功（回退排程模式，AudioContext=' + audioCtx.state + '）');
            }
            // 静音检测：前 150 帧统计峰值，判断手机采集到的音频是否本身就是无声
            if (audioSilenceCheck === null) {
              for (let i = 0; i < interleaved.length; i++) {
                const a = Math.abs(interleaved[i]);
                if (a > audioPeak) audioPeak = a;
              }
              if (audioDecodeCount >= 150) {
                audioSilenceCheck = audioPeak < 0.0001;
                reportAudioState(audioSilenceCheck
                  ? '静音判定：手机采集到的是无声数据（3 秒峰值=' + audioPeak.toFixed(5) + '）。手机端问题：媒体音量为 0 或该 App 禁止录音'
                  : '信号判定：音频信号正常（3 秒峰值=' + audioPeak.toFixed(3) + '）。若听不到请检查电脑音量/输出设备/浏览器标签页是否被系统静音');
              }
            }
          } catch (e) {
            // 输出回调里的异常不会进入 error 回调，必须在此显式上报，否则静默丢帧
            reportAudioState('播放处理异常：' + e.message);
          }
        },
        error(e) {
          reportAudioState('解码错误：' + e.message);
        },
      });
      // 解码器就绪后立即应用缓存的配置包（v0.5.1 的顺序 bug：ensureAudioCtx 末尾补配置时
      // 解码器尚未创建，导致缓存永远没被应用——数据全丢、无声）
      applyAudioConfigFromCache();
      document.getElementById('btn-mute').disabled = false;
      document.getElementById('btn-mute').textContent = audioMuted ? '🔇 已静音' : '🔊 声音';
      log('[音频] 已就绪（Opus，电脑端播放手机声音）');
    }

    function teardownAudio() {
      if (audioDecoder && audioDecoder.state !== 'closed') {
        try { audioDecoder.close(); } catch {}
      }
      audioDecoder = null;
      audioConfigured = false;
      audioConfigCache = null;
      audioDecodeCount = 0;
      audioFeedCount = 0;
      audioPeak = 0;
      audioSilenceCheck = null;
      audioUnconfiguredDrops = 0;
      audioPlaybackTime = 0;
      // 终止解码 Worker（下次投屏 ensureAudioCtx 重建）
      if (audioWorker) {
        try { audioWorker.terminate(); } catch {}
        audioWorker = null;
      }
      audioWorkerReady = false;
      // 清空环形缓冲（下次投屏从水位重新起播）
      if (audioWorkletNode) {
        try { audioWorkletNode.port.postMessage({ cmd: 'flush' }); } catch {}
      }
      document.getElementById('btn-mute').disabled = true;
    }

    // 静音切换暴露给外部按钮（无线面板共用「🔊 声音」按钮）
    window.__wlAudioToggle = () => {
      audioMuted = !audioMuted;
      if (audioGain) audioGain.gain.value = audioMuted ? 0 : 1;
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      document.getElementById('btn-mute').textContent = audioMuted ? '🔇 已静音' : '🔊 声音';
      log(audioMuted ? '[音频] 已静音（电脑端）' : '[音频] 取消静音，正在播放手机声音');
    };

    // 自动播放策略兜底：页面被点击时若音频仍被暂挂则恢复
    document.addEventListener('click', () => {
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().then(() => {
          if (audioCtx.state === 'running') log('[音频] 输出已恢复');
        }).catch(() => {});
      }
    });

    let audioConfigCache = null; // 前端缓存的 OpusHead 配置包（ctx 就绪后自动补配置，不依赖服务端补发时序）

    // 用缓存的 OpusHead 配置解码器；ctx 未就绪时静默等待（ensureAudioCtx 完成后会回调本函数）
    function applyAudioConfigFromCache() {
      if (audioConfigured || !audioDecoder || !audioConfigCache) return;
      const payload = audioConfigCache;
      if (payload.length >= 11 && payload[0] === 0x4f && payload[1] === 0x70 && payload[2] === 0x75 && payload[3] === 0x73) {
        audioChannels = payload[9] || 2;
        // 先按无 description 配置（Chrome 标准用法），失败再带上 OpusHead
        const configs = [
          { codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: audioChannels },
          { codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: audioChannels, description: payload },
        ];
        for (const cfg of configs) {
          try {
            audioDecoder.configure(cfg);
            audioConfigured = true;
            reportAudioState('解码器已配置（声道=' + audioChannels + (cfg.description ? '，带 OpusHead' : '') + '）');
            return;
          } catch (e) {
            var lastErr = e; // 记录最后一次错误
          }
        }
        reportAudioState('配置失败：' + (lastErr ? lastErr.message : '未知错误'));
      }
    }

    function onAudioData(isConfig, payload) {
      lastAudioDataTime = performance.now(); // 看门狗②：音频活=采集进程活，音频正常而视频停摆→采集侧问题
      // 优先路径：解码 Worker 已就绪 → 原始包直接转发（拷贝一份，worker 与主线程互不干扰）
      if (audioWorkerReady && workletBound && audioWorker) {
        const copy = payload.slice();
        if (isConfig) {
          audioWorker.postMessage({ type: 'config', data: copy.buffer }, [copy.buffer]);
          audioConfigCache = payload; // 仍缓存：worker 掉线回退主线程时可补配置
          return;
        }
        audioWorker.postMessage({ type: 'chunk', data: copy.buffer }, [copy.buffer]);
        return;
      }
      if (isConfig) {
        // 配置包为 OpusHead（服务端已剥好）：缓存并立即尝试配置（解码器未建好时等 ctx 就绪后补）
        audioConfigCache = payload;
        if (audioDecoder) applyAudioConfigFromCache();
        return;
      }
      if (!audioDecoder) return;
      if (!audioConfigured) {
        // 未收到配置包（OpusHead 只在投屏开始时广播一次，页面刷新后不再重发）
        audioUnconfiguredDrops++;
        if (audioUnconfiguredDrops === 50) {
          reportAudioState('⚠ 收到了音频数据但没有配置包，无法解码（页面刷新后中途接入）。请停止投屏后重新开始');
        }
        return;
      }
      try {
        audioDecoder.decode(new EncodedAudioChunk({
          type: 'key',
          timestamp: audioFeedCount * FRAME_DURATION_US, // 送入时严格递增，与输出解耦
          duration: FRAME_DURATION_US,
          data: payload,
        }));
        audioFeedCount++;
      } catch (e) {
        reportAudioState('送解码失败：' + e.message);
      }
    }

    /* ---------- WebSocket ---------- */
    function connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/wireless`);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        log('已连接无线投屏服务');
        ws.send(JSON.stringify({ type: 'status' }));
      };
      ws.onclose = () => {
        log('无线服务连接断开，重连中…');
        setTimeout(connect, 2000);
      };
      ws.onerror = () => {};
      ws.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          const u8 = new Uint8Array(ev.data);
          // 音频帧：服务端加 1 字节前缀区分（'C'=OpusHead 配置包，'P'=Opus 音频包）
          if (u8.length > 0 && (u8[0] === 0x43 || u8[0] === 0x50)) {
            onAudioData(u8[0] === 0x43, u8.subarray(1));
            return;
          }
          ensureDecoder();
          configureIfNeeded();
          onVideoData(ev.data);
          return;
        }
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'status') {
          setStatus(msg.message);
          const wasStreaming = wsState === 'streaming';
          updateButtons(msg.state);
          if (msg.state === 'ready') {
            // 页面自刷新兑底后自动续播（仅自刷新流程触发，普通使用不受影响）
            try {
              if (sessionStorage.getItem('wl-auto-start') === '1') {
                sessionStorage.removeItem('wl-auto-start');
                log('自动恢复：重新开始投屏…');
                setTimeout(() => { try { $('wl-btn-start').click(); } catch {} }, 800);
              }
            } catch {}
          }
          if (msg.state === 'streaming') {
            if (wasStreaming) resetDecoder(); else { configured = false; keyChunkNeeded = true; }
            ensureDecoder();
            hideQrZone();
          } else if (wasStreaming) {
            resetDecoder();
            teardownAudio();
            if (String(msg.message || '').indexOf('自动重启') !== -1) {
              // 看门狗/阶梯触发的自动重启：新会话几秒内接上——保留最后一帧画面与提示，
              // 不黑屏不清画（黑屏+清音频会让用户误以为“彻底断开”）
              setStatus('画面重连中…（' + (msg.message || '') + '）');
            } else {
              hideCanvas();
            }
            stopFps();
          }
        } else if (msg.type === 'last-connection') {
          // 上次成功连接的地址：自动回填并尝试自动连接（仅空闲时，一次会话只自动试一次）
          if (msg.addr && wsState === 'idle' && !autoConnectTried) {
            autoConnectTried = true;
            if (!$('wl-connect-addr').value.trim()) {
              $('wl-connect-addr').value = msg.addr;
              log('检测到上次连接的地址 ' + msg.addr + '，正在自动连接…');
              ws.send(JSON.stringify({ type: 'connect', addr: msg.addr }));
            }
          }
        } else if (msg.type === 'audio') {
          // 服务端音频通道状态通知（async 调用必须接 catch：否则初始化异常被 Promise 静默吞掉，日志零痕迹）
          if (msg.enabled) { setupAudio().catch((e) => reportAudioState('初始化异常：' + e.message)); }
          else {
            teardownAudio();
            if (msg.reason === 'device') log('ℹ 手机系统不支持音频采集（需 Android 11+），仅投屏画面');
            else if (msg.reason === 'codec') log('ℹ 音频编码不受支持，仅投屏画面');
            else if (msg.reason === 'closed') log('ℹ 音频通道已断开（画面不受影响）');
          }
        } else if (msg.type === 'qr-pair') {
          // 服务端生成配对二维码，展示并等待手机扫码
          showQrZone(msg.qr);
          log('二维码已生成，请用手机相机扫码（服务实例：' + msg.instance + '）');
        } else if (msg.type === 'qr-pair-pending') {
          // 页面刷新时若扫码配对进行中，提示重新发起（二维码不重复推送）
          log('扫码配对正在进行中，如二维码未显示请点击「扫码配对」重新生成');
        } else if (msg.type === 'qr-pair-cancel') {
          hideQrZone();
        } else if (msg.type === 'stream-info') {
          // 服务端开流时的链路/编码信息（指标面板展示）
          streamInfo = msg;
        } else if (msg.type === 'pong') {
          // RTT 探测回显：发送时刻与当前时刻差即往返延迟
          rttMs = Math.max(0, Date.now() - (msg.t || Date.now()));
        } else if (msg.type === 'log') {
          log(msg.message);
        } else if (msg.type === 'error') {
          log('❌ ' + msg.message);
          setStatus(msg.message);
          hideQrZone();
        }
      };
    }

    let configured = false;
    let configuredCodec = null; // 解码器当前配置的 codec 串（首帧后用 SPS 真实规格覆盖默认值）
    function configureIfNeeded() {
      if (configured || !decoder) return;
      if (decoder.state === 'unconfigured') {
        // 码流为 Annex-B（无 description），SPS/PPS 在带内随关键帧送入，Chrome/Edge 可自动解析；
        // 首个关键帧到达后再按 SPS 真实规格重新配置（见 feedDecoder）
        // 实时镜像曾尝试 optimizeForLatency:true，但在「呈现队列持有多个 VideoFrame」的架构下
        // 会缩小解码器输出池容限、与队列滞留帧叠加造成输出停摆（v0.7.2-0.7.4 死锁教训），勿加回
        decoder.configure({ codec: 'avc1.42E01F' });
        configuredCodec = 'avc1.42E01F';
        configured = true;
        startFps();
      }
    }

    function startFps() {
      stopFps();
      frameCount = 0; fpsTime = performance.now();
      fpsTimer = setInterval(() => {
        const now = performance.now();
        const sec = (now - fpsTime) / 1000;
        const fps = sec > 0 ? Math.round(frameCount / sec) : 0;
        $('info-fps').textContent = fps + ' fps (无线)';
        $('stat-text').textContent = canvasEl.width + '×' + canvasEl.height;
        frameCount = 0; fpsTime = now;
        // ---- 指标面板（v0.7.3）：到达/呈现帧率分离、真实码率、丢弃计数、音画差 ----
        const metricsEl = document.getElementById('wl-metrics');
        if (metricsEl) {
          const mbps = sec > 0 ? (videoBytesWindow * 8 / 1e6 / sec) : 0;
          const q = decoder ? decoder.decodeQueueSize : 0;
          const link = streamInfo ? streamInfo.link : '';
          const inFps = sec > 0 ? Math.round(decodedWindow / sec) : 0;
          const syncErr = audioBufferMs ? Math.round(audioBufferMs - 150) : 0;
          const parts = [
            '链路 ' + (link || '—') + (streamInfo && streamInfo.softwareEncoder ? '·软编' : ''),
            '到达 ' + inFps + ' / 呈现 ' + fps + ' fps',
            '码率 ' + (mbps ? mbps.toFixed(1) + 'Mbps' : '—'),
            '队列 ' + q + (queueDrops ? '，丢' + queueDrops : ''),
            '水位 ' + (audioBufferMs ? Math.round(audioBufferMs) + 'ms' : '—'),
            'RTT ' + (rttMs >= 0 ? Math.round(rttMs) + 'ms' : '—'),
            '音画差 ' + syncErr + 'ms',
            (stallEscalation > 0 ? '自愈' + stallEscalation + '级' : ''),
          ].filter(Boolean);
          metricsEl.style.display = 'block';
          metricsEl.textContent = parts.join(' · ');
        }
        videoBytesWindow = 0;
        decodedWindow = 0;
        queueDrops = 0;
        // RTT 探测（每秒一次，轻量：仅在 WS 打开时发送）
        if (ws && ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify({ type: 'ping', t: Date.now() })); } catch {}
        }
        // ---- 卡屏看门狗 ----
        // ⓪ 渲染兑底：有待上屏帧但 1.2s 没画（rAF 挂起、排队标记永真）→ 定时器强制上屏打破死锁
        if (frameQueue.length && lastPaintTime && now - lastPaintTime > 1200) {
          if (paintTimer) clearTimeout(paintTimer);
          paintTimer = setTimeout(paintFrame, 100);
        }
        // ① 有视频数据但 2.5s 不出帧：浏览器解码器停摆（硬件解码偶发卡死且无错误回调）→ 强制重建
        if (decoder && configured && !keyChunkNeeded && lastVideoDataTime &&
            now - lastVideoDataTime < 1500 && now - lastPaintTime > 2500 &&
            now - lastRebuildAt > 8000) {
          stallEscalation = Math.max(stallEscalation, 1);
          forceDecoderRebuild(now);
        }
        // ② 视频无数据 3.5s：先区分「手机暂停/画面静止」与「真实停滞」——
        //    scrcpy 对静止画面不产生视频帧（暂停、静态页面都如此），这是正常现象不能当停滞重启；
        //    判据：手机仍在出声（解码电平 5s 内有信号）→ 真实停滞，自动重启会话；
        //    手机无声 → 大概率暂停/静止，仅提示待机，恢复播放后画面自动接上
        else if (ws && ws.readyState === WebSocket.OPEN && lastAudioDataTime &&
            now - lastAudioDataTime < 3000 && lastVideoDataTime &&
            now - lastVideoDataTime > 3500) {
          const phoneActive = audioLivePeakAt && now - audioLivePeakAt < 5000 && audioLivePeak > 0.02;
          if (phoneActive) {
            if (now - lastStallNotify > 45000) {
              stallNotifyTimes = stallNotifyTimes.filter((t) => now - t < 600000);
              if (stallNotifyTimes.length >= 5) {
                if (now - lastCapHintAt > 60000) {
                  lastCapHintAt = now;
                  log('⚠ 10 分钟内已自动重启 5 次仍未稳定：手机端采集正被系统反复中断，已暂停自动重启。请点「停止投屏」再重新开始（重置计数）；持续如此建议手机插线或检查省电策略');
                }
              } else {
                stallNotifyTimes.push(now);
                stallEscalation++;
                lastStallNotify = now;
                log('⚠ 视频流停滞（手机仍在出声），已请求服务端重启采集…');
                try { ws.send(JSON.stringify({ type: 'video-stall' })); } catch {}
              }
            }
          } else {
            if (now - lastIdleHintAt > 10000) {
              lastIdleHintAt = now;
              log('ℹ 手机画面静止且无声：可能已暂停或画面无变化（投屏待机中，恢复播放画面自动接上；若手机仍在播放请点「重新开始」）');
            }
            $('info-fps').textContent = '⏸ 待机（手机画面静止/暂停）';
          }
        }
        // ③ ①已重建过但 6.5s 仍不出帧（关键帧迟迟不到/重建无效）→ 升级为重启采集会话（仅手机在播时）
        else if (lastRebuildAt && lastAudioDataTime && now - lastAudioDataTime < 3000 &&
            audioLivePeakAt && now - audioLivePeakAt < 5000 && audioLivePeak > 0.02 &&
            now - lastPaintTime > 6500 && now - lastStallNotify > 45000) {
          stallEscalation++;
          lastStallNotify = now;
          log('⚠ 解码器重建后画面仍未恢复，升级为重启采集会话…');
          try { ws.send(JSON.stringify({ type: 'video-stall' })); } catch {}
        }
        // ④ 重建+重启会话仍无效（解码/渲染环境级故障）→ 自刷新页面兑底（5 分钟最多一次，刷新后自动续播）
        else if (lastPaintTime && lastAudioDataTime && now - lastAudioDataTime < 3000 &&
            audioLivePeakAt && now - audioLivePeakAt < 5000 && audioLivePeak > 0.02 &&
            now - lastPaintTime > 12000 && stallEscalation >= 2 &&
            Date.now() - lastReloadAt > 300000) {
          log('⚠ 多级自愈均无效，自动刷新页面重置解码环境（刷新后自动重新投屏）…');
          try {
            sessionStorage.setItem('wl-auto-reload-at', String(Date.now()));
            sessionStorage.setItem('wl-auto-start', '1');
          } catch {}
          location.reload();
        }
      }, 1000);
    }
    function stopFps() {
      if (fpsTimer) clearInterval(fpsTimer);
      fpsTimer = null;
      $('info-fps').textContent = '—';
    }

    /* ---------- 按钮 ---------- */
    function sendSafe(obj) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
      else log('⚠ 命令未发送：服务连接已断开，正在重连…');
    }
    function showQrZone(qrDataUrl) {
      $('wl-qr-img').src = qrDataUrl;
      $('wl-qr-zone').style.display = 'flex';
      $('wl-qr-zone').style.flexDirection = 'column';
      $('wl-qr-zone').style.alignItems = 'center';
      $('wl-btn-qr-pair').style.display = 'none';
    }
    function hideQrZone() {
      $('wl-qr-zone').style.display = 'none';
      $('wl-btn-qr-pair').style.display = '';
    }
    $('wl-btn-qr-pair').onclick = () => {
      sendSafe({ type: 'qr-pair-start' });
      setStatus('正在生成二维码…');
    };
    $('wl-btn-qr-cancel').onclick = () => {
      sendSafe({ type: 'qr-pair-cancel' });
      hideQrZone();
    };
    $('wl-btn-pair').onclick = () => {
      const addr = $('wl-pair-addr').value.trim();
      const code = $('wl-pair-code').value.trim();
      if (!addr) { alert('请输入手机「使用配对码配对设备」弹窗中显示的 IP:端口（注意与无线调试主页的地址不同）'); return; }
      if (!/^\d{6}$/.test(code)) { alert('请输入 6 位配对码'); return; }
      sendSafe({ type: 'pair', addr, code });
      setStatus('正在配对…');
    };
    $('wl-btn-connect').onclick = () => {
      const addr = $('wl-connect-addr').value.trim();
      sendSafe({ type: 'connect', addr });
      setStatus('正在连接…');
    };
    // 恢复上次使用的画质档位与熄屏选项（页面自刷新兑底后自动续播也用它们）
    try {
      const savedQ = localStorage.getItem('wl-quality');
      if (savedQ) { const qel = document.getElementById('wl-quality'); if (qel) qel.value = savedQ; }
      if (localStorage.getItem('wl-screen-off') === '1') {
        const so = document.getElementById('wl-screen-off');
        if (so) so.checked = true;
      }
    } catch {}
    $('wl-btn-start').onclick = () => {
      resetDecoder();
      // 画质档位 → scrcpy 参数：max_size 0 = 手机原始分辨率；码率越高越清晰（占带宽越多）
      const q = $('wl-quality') ? $('wl-quality').value : 'high';
      try { localStorage.setItem('wl-quality', q); } catch {} // 持久化：页面自刷新兑底后自动续播用
      const screenOff = !!document.getElementById('wl-screen-off')?.checked;
      try { localStorage.setItem('wl-screen-off', screenOff ? '1' : '0'); } catch {}
      const presets = {
        high: { maxSize: 1920, bitrate: 16000000, maxFps: 60 },
        balanced: { maxSize: 1600, bitrate: 10000000, maxFps: 60 },
        native: { maxSize: 0, bitrate: 20000000, maxFps: 60 },
      };
      const preset = presets[q] || presets.high;
      upscaleHinted = false;
      sendSafe({ type: 'start', maxSize: preset.maxSize, bitrate: preset.bitrate, maxFps: preset.maxFps, screenOff });
    };
    $('wl-btn-stop').onclick = () => {
      sendSafe({ type: 'stop' });
    };

    // 「停止投屏」按钮同时清理无线画面
    const origStop = $('btn-stop').onclick;
    $('btn-stop').onclick = function (ev) {
      if (canvasEl.style.display === 'block') {
        sendSafe({ type: 'stop' });
        return;
      }
      if (origStop) origStop.call(this, ev);
    };

    connect();
  })();
})();
