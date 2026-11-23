# 更新日志

本文件遵循 [语义化版本](https://semver.org/lang/zh-CN/) 规范。





## [v0.6.4] - 2026-11-23

### 优化：卡屏自愈提速到 ≤5s + 修复连接缓存残留旧端口

- **卡屏提速**（日志证据：16:58 场音频全程 30kbps 正常而画面冻结 → 手机端编码器停摆；另有几场手机侧音频也退化到 ~0B/s 的采集级中断）：
  - 看门狗②判定阈值 8s → **3.5s**（音频正常但无视频数据即上报，服务端重启采集会话秒发关键帧）
  - 新增看门狗③升级：解码器重建后 6.5s 仍不出帧（等不到关键帧）→ 直接升级为重启采集会话，不再干等最长 10s 的 I 帧间隔
  - 客户端上报限频 60s → 45s
- **根因缓解**（`server/adb.js`）：scrcpy 启动参数加 `stay_awake=true`——投屏期间持有唤醒锁，减少手机省电策略冻结采集/熄屏中断（vivo Android 16 管控激进，熄屏时画面停摆、音频退化为静音包）
- **修复连接缓存**（`server/wireless.js`）：
  - 根因：`tryAutoConnect()` 路径 2（adb devices 已就绪的无线设备）连接成功后**不写缓存**，导致 data/last-connection.json 永远残留旧端口（三次成功连上 33515 后回填的仍是 38051，每次白等 20s 超时）——现在所有成功路径统一覆盖式保存，只记住最近一次
  - 显式地址连接失败 → 自动回退 mDNS 发现当前端口（无线调试重启后端口会变），免去手动重输
- 语法检查与 21 项单测全过
## [v0.6.3] - 2026-11-23

### 修复：播放数分钟后画面停摆（音频正常）——两级看门狗自愈

- **根因**：音频活着说明 scrcpy 采集进程与 WS 连接都正常，问题只在视频腿，且此前的错误恢复覆盖不到两类「无报错停摆」：① Chrome 硬件解码器偶发卡死（不报错、不 close、队列不涨）；② 手机端视频编码器停摆（进程活着但视频流无数据，客户端无法自救）。另 v0.6.1 的 rAF 呈现在窗口被完全遮挡时停摆（音频走 Worker 不受影响）→ 画面冻结
- **方案**：
  - **看门狗①（解码侧）**：1s 巡检，视频数据仍在到达但 2.5s 不出帧 → `forceDecoderRebuild()` 整体重建解码器等下个关键帧，8s 门限防连环重建
  - **看门狗②（采集侧）**：音频正常但 8s 无视频数据 → 客户端上报 `video-stall`（60s 一次），服务端自动 stop+start 重启采集会话（30s 一次），复用原画质参数
  - **遮挡兑底**：页面不可见（切后台/被完全遮挡）时 rAF 停摆，改 250ms 定时器兑底上屏最新帧；重新可见立即排队上屏——后台窗口画面不再冻结
  - 修正积压重置时序：`decoder.reset()` 可能回到未配置态，`feedDecoder` 在 reset 之后统一补 configure，避免 decode 抛 InvalidStateError 丢帧
- 语法检查与 21 项单测全过
## [v0.6.2] - 2026-11-23

### 修复：竖屏⇄横屏旋转后画面永久冻结（声音正常）

- **根因**：旋转时 scrcpy 推送新分辨率的新 SPS/PPS+IDR。WebCodecs 对带内分辨率切换的兼容性不可靠，一旦解码器报错进入 `closed` 态，`feedDecoder` 对后续所有帧静默 return——画面冻结，音频链路独立不受影响，于是「卡住但有声」
- **方案**（`public/receive.html`）：
  - **SPS 变化检测**：新 SPS 与旧 SPS 字节不一致时标记 `rotationPending`，在下一个关键帧处 `decoder.reset()`（清旧参考帧/队列），用新 SPS/PPS+IDR 干净起播——旋转时关键帧立即送到，恢复是瞬时的
  - **解码错误自动恢复** `recoverDecoder()`：软错误 `reset()` 清错误态；致命错误（closed 态）整体重建解码器并重新 configure；两者都等下个关键帧干净起播（防错误风暴只调度一次）
  - `feedDecoder` 对 `unconfigured` 态自动重新 configure；`resetDecoder` 清空旋转/恢复/积压全部状态
- 语法检查与 21 项单测全过
## [v0.6.1] - 2026-11-23

### 优化：倍速播放（1.25x/1.5x）时视频卡顿

- **根因（三个叠加）**：① 解码输出回调里直接 `drawImage`，帧到达抖动直接映射为画面抖动（倍速时帧间隔压缩，抖动被放大）；② WebCodecs 解码队列积压无丢帧/重同步机制，网络或解码抖一下延迟持续累积；③ 「流畅」档 `max_fps=45` 上限太低
- **方案**（`public/receive.html`）：
  - **rAF 垂直同步呈现**：解码出的帧暂存为 `presentFrame`（被更新的帧立即 close，零积压），`requestAnimationFrame` 每个刷新周期上屏最新一帧，到达抖动与呈现解耦
  - **解码积压自动重同步**：`decodeQueueSize > 8`（≈130ms@60fps）进入丢帧模式，丢弃所有 delta 帧直到下一个关键帧（`decoder.reset()` + in-band SPS/PPS 重新起播），延迟不累积
  - 「流畅」档 45fps → **60fps**、8Mbps → 10Mbps；三档全部 60fps，可稳定承载 1.5 倍速内容（1.5x 的 30fps 源 = 45fps 有效帧率，仍在 60fps 采集上限内）
  - `resetDecoder` 同步清空积压状态与待呈现帧
- 语法检查与 21 项单测全过
## [v0.6.0] - 2026-11-23

### 修复：浏览器窗口不在最顶层时声音断断续续

- **根因**：音频解码（`AudioDecoder`）与 PCM 搬运全在页面主线程。窗口被其它应用遮挡后，Chrome 把该页面的渲染/主线程降到低优先级（后台标签降频保护），解码回调被拉长、环形缓冲得不到及时补充，听感就是持续断续；切回顶层后主线程恢复高优先级，缓冲立刻被填满，所以「瞬间就好了」。这不是网络或手机端问题——服务端日志里的音频流量始终平稳
- **方案**（`public/receive.html`）：把整条音频链路搬出主线程
  - 新增 `AUDIO_WORKER_SRC`：Worker（Blob URL 创建）内部独立完成 `AudioDecoder` 创建、OpusHead 配置、Opus 解码、planar→交错 f32 转换、静音/峰值自检，**主线程完全不参与解码**
  - `MessageChannel` 直通：`worker` 侧持 `port2`，`port1` 通过 `AudioWorkletNode.port.postMessage({cmd:'bind-port'}, [port1])` **转移所有权**进 AudioWorklet；解码出的 PCM 由 worker 直接 `postMessage` 给 worklet 写环形缓冲，PCM 数据不经主线程（原「音频解码/搬运全在主线程」的问题被从机制上移除）
  - 主线程只剩一件事：把 WS 收到的原始 Opus 包 `slice()` 后 `postMessage` 转移给 worker（纯转发，无解码、无分配大对象）
  - **worker 不可用时完整回退**：`AudioDecoder` 在 Worker 内不可用会回报 `ready.ok=false`，自动降回原主线程解码路径（行为与 v0.5.3 一致，只是仍有断续风险）
  - 细节：worker 就绪前到达的 OpusHead 配置包会缓存并在就绪时**补发**（否则 worker 一直未配置、数据全丢——与 v0.5.1 同类的时序坑）；worker 侧丢弃帧数达到 50 会回报「未收到配置包」；`teardownAudio` / 重新投屏都会 `terminate()` 旧 worker 重建

### 优化：全屏放大后画面发糊

- **根因**：采集侧 `max_size=1600` + `video_bit_rate=8M` 过于保守。手机是 1080p 级屏，缩到 1600 长边再经浏览器放大铺满窗口，像素是插值出来的，码率也不足以承载细节——糊的主因是**源分辨率不够**，不是解码或渲染问题
- **方案**：
  - `public/receive.html` 新增画质档位（开始投屏前可选）：高清 1920 / 16Mbps / 60fps（默认）、流畅 1600 / 8Mbps / 45fps、**原生 手机原始分辨率（不传 `max_size`）/ 20Mbps / 60fps**
  - `server/adb.js` 默认值同步提升：`bitrate` 8M → **16M**，`maxSize` 1600 → **1920**；`maxSize` 为 0 时**不追加** `max_size` 参数（走 scrcpy 原生分辨率）
  - 档位补 `max_fps`：限帧把码率集中在每帧细节上，而不是分摊到重复帧
  - 新增**清晰度自检**：解码出首帧后比较源宽与显示宽（含 devicePixelRatio），放大倍数 ≥1.25 且当前非原生档时提示「若觉得糊，切原生档」，避免用户误判为软件画质问题；窗口尺寸变化会重新评估
- 语法检查（主脚本 / worklet 模板 / worker 模板三处）与 21 项单测全过

## [v0.5.3] - 2026-11-23

### 修复：v0.5.0 误删变量声明导致音频初始化崩溃

- **根因（日志直接抓到）**：`初始化异常：audioPlaybackTime is not defined`——v0.5.0 引入环形缓冲时删除了旧排程参数的声明，但回退排程路径与 setup/teardown 的重置代码仍引用 `audioPlaybackTime`，`setupAudio()` 在重置阶段即抛 ReferenceError，整个音频初始化中断
- **修复**（`public/receive.html`）：补回 `let audioPlaybackTime = 0` 声明（回退逐帧排程模式专用；主路径环形缓冲不使用）
- v0.5.2 引入的 async 异常上报在这轮发挥了作用：错误第一次以一行日志的形式被直接定位，而不是无声无息
- 语法检查与 21 项单测全过

## [v0.5.2] - 2026-11-23

### 修复：v0.5.1 补配置调用时机错误，配置包缓存从未被应用

- **根因**：v0.5.1 把 `applyAudioConfigFromCache()` 放在 `ensureAudioCtx()` 末尾——但那一刻 `AudioDecoder` 还没创建（它在 `await ensureAudioCtx()` 之后才 new），函数检测无解码器直接返回，缓存的 OpusHead 永远没被应用，音频数据持续丢弃
- **修复**（`public/receive.html`）：
  - `AudioDecoder` 创建完成后**立即**调用 `applyAudioConfigFromCache()`——配置包到达无论早于/晚于初始化，两条路径都能正确补上
  - `setupAudio()` 的 fire-and-forget 调用处补 `.catch()` 上报——此前 async 初始化的异常被 Promise 静默吞掉，日志零痕迹（这也是上轮日志「零浏览器回报」却无任何错误的原因）
- 语法检查与 21 项单测全过

## [v0.5.1] - 2026-11-23

### 修复：v0.5.0 引入的竞态导致无声回归

- **根因（日志定位）**：环形缓冲就绪（「输出设备就绪（环形缓冲）」）之后，「解码器已配置」与「首帧解码成功」均未出现——数据在解码前全部丢弃。v0.5.0 中 `setupAudio()` 调用异步的 `ensureAudioCtx()`（内含 `audioWorklet.addModule`）却没有等待：配置包在投屏开始瞬间广播，此刻解码器尚未配置，而服务端配置包补发只在 WS 建立时触发一次，错过即永失
- **修复**（`public/receive.html`）：
  - **前端缓存 OpusHead 配置包**（`audioConfigCache`）：收到即缓存；输出环境（ctx + worklet）就绪后自动补配置（`applyAudioConfigFromCache`）——不再依赖服务端补发时序
  - `setupAudio()` 改为 async：先 `await ensureAudioCtx()` 再创建 AudioDecoder，初始化顺序有严格保证，竞态从机制上消除
- 语法检查与 21 项单测全过

## [v0.5.0] - 2026-11-23

### 优化：AudioWorklet 环形缓冲，根治残余杂音与卡顿感

- **残余杂音根因**：v0.4.0 后仍有轻微卡顿感——逐帧 `createBufferSource` 排程模式下，每帧音频独立开始/结束，**帧边界的采样永远无法绝对连续**，20ms 一次的微小不连续即表现为持续细碎杂音；且日志显示零欠载（非网络断流问题），确认为排程模型固有缺陷
- **方案**（`public/receive.html`）：播放核心改为 **AudioWorklet + 环形缓冲**——解码帧零拷贝（转移所有权）写入 1 秒容量的环形缓冲，worklet 以**单一连续播放时钟**逐采样消费，帧边界杂音从机制上消除
  - 起播水位 150ms：缓冲积累足够才开始播放，吸收抖动
  - 缓冲过深（>800ms）自动丢最旧 100ms：延迟不无限累积
  - 欠载补零但**不重置时钟**：播放时钟永不跳变，缓冲回升自动无缝接上
  - worklet 不可用（或采样率与设备不一致）时自动回退 v0.4.0 的逐帧排程模式，功能不丢
  - 起播/欠载事件回报到页面与服务端日志
- 模块源码内嵌为模板字符串（Blob URL 加载），无需额外静态文件；主脚本与 worklet 源码分别通过语法检查，21 项单测全过

## [v0.4.0] - 2026-11-23

### 优化：消除投屏杂音（起播缓冲 + 连续排程 + 欠载淡出）

声音链路打通（v0.3.3）后存在杂音，根因是旧的排程策略过于粗暴。本次按业界标准做法重写播放排程：

- **起播缓冲**：首帧延后 100ms 播放，建立抖动余量——网络/解码抖动不再直接暴露为断流爆音
- **连续排程**：旧逻辑「排程时刻超前 100ms 就重置时钟」，每次重置都是一次音频跳变（周期性咔哒声）。新逻辑只要排程时刻超前不超过 300ms 就让它自然前进、**绝不中途重置**；超前过多时丢弃当前 20ms 帧而非跳变——宁可少一帧也不制造杂音
- **欠载淡出**：真正断流（缓冲耗尽）需要重建时钟时，先对正在播放的音频做 15ms 快速淡出再重置，避免最刺耳的硬切咔哒声；欠载事件回报到页面与服务端日志（频繁欠载 = WiFi 质量问题的信号）
- 全部参数（起播 100ms / 容忍 300ms / 淡出 15ms）以常量集中定义，后续可调

## [v0.3.3] - 2026-11-23

### 修复：投屏无声的真正根因（AudioData API 误用）

- **根因（由日志钉死后源码定位）**：服务端日志显示「手机在发真实音频数据（约 99kbps）、浏览器输出设备就绪、解码器配置成功，但首帧解码报告永不出现」。比对在 Chrome 验证可用的 WebCodecs Opus 实现后确认——`AudioDecoder` 的 output 回调误用了**不存在**的 `AudioData.getChannelData()`（那是 WebAudio `AudioBuffer` 的 API，WebCodecs 正确 API 是 `copyTo(plane, {planeIndex, formatOverride})`）。回调首行即抛 TypeError，而 WebCodecs 对 output 回调异常**静默吞掉**：不进 error 回调、无控制台报错、无声音。此 bug 自 v0.3.0 引入音频功能起就存在
- **修复**（`public/receive.html`）：
  - 按正确 API 重写输出回调：`copyTo` 取 f32-planar 平面数据（附交错格式兼容分支），`AudioData` 用完显式 `close()` 释放
  - 输出回调整体 try/catch：任何处理异常都会回报到页面与服务端文件日志（此前异常静默丢失，正是前几轮排查不到的原因）
  - 送解码的时间戳改为**送入时**严格递增（与输出计数解耦——此前时间戳依赖「解码成功才递增」的计数，形成死循环）
- **验证**：浏览器端语法检查、服务端 `node --check`、21 项单测全过

## [v0.3.2] - 2026-11-23

### 修复：投屏有画面但电脑端听不到手机声音

服务端日志已确认音频通道正常（手机在采集、服务端在转发），问题出在电脑端浏览器播放环节，本次针对性修复四个候选原因：

- **自动播放策略暂挂（最可能原因）**：投屏由「自动连接 + 自动开始」触发时全程无用户手势，Chrome 会把 `AudioContext` 置为 suspended（静音状态）。现在创建上下文时主动 `resume`，仍被暂挂时页面给出明确提示「点击页面任意位置即可恢复」，并新增全局点击兜底恢复
- **插拔耳机导致输出失效**：切换输出设备（接/拔有线耳机）后旧 `AudioContext` 可能仍指向失效设备。现在**每次投屏都重建** `AudioContext`（先关闭旧上下文），始终绑到当前输出设备
- **Opus 解码配置兼容**：改为两段式配置——先按 Chrome 标准写法（`opus` + 采样率/声道数，不带 description），失败再回退带 OpusHead description 的写法
- **诊断日志**：前端记录「已开始播放手机声音」（首帧解码排程成功时）与输出设备就绪状态；服务端记录「已收到手机音频数据」（首个音频包到达时）。下次无声时看页面日志即可区分是「手机没发声」还是「电脑没放出」，服务端首包事件同步落盘 `logs/localcast.log`

## [v0.3.1] - 2026-11-23

### 修复：开音频后卡在「正在启动屏幕采集…」

- **根因**：死锁。scrcpy 服务端要依次接受两条连接（先视频后音频）、**全部就绪后**才启动编码器开始发视频数据；而旧逻辑是「等视频通道收到第一个数据包才去连音频」——双方互等，永远卡住
- **修复**：启用 `send_dummy_byte=true`（scrcpy 官方为此场景设计的机制）——服务端接受视频 socket 后**立即**写 1 字节哑字节（先于音频 accept），服务端用该字节确认视频通道，随后再连音频 socket，时序打通
- **顺带修复**：通道建立时对 socket 的 `pause()` 未恢复导致后续数据不触发的隐患（改为在 openStream 内直接挂载数据回调，不再 pause/unshift）

## [v0.3.0] - 2026-11-23

### 新增：无线投屏声音（手机声音在电脑端播放）

- **协议**（`server/adb.js` / `server/wireless.js`）：scrcpy-server 开启 `audio=opus` 通道。弃用 `raw_stream=true`（它会同时关掉音频帧元数据，而 Opus 裸包无自定界能力，无法解码），改用分粒度选项保留帧头；tunnel_forward 模式下按 **video → audio** 顺序各连一条 socket（音频 socket 不连接则服务端阻塞在 accept，不会开始采集）
- **服务端流分发**：新增 `ScrcpyStreamReader` 解析 scrcpy 线格式（4 字节编码器 id + 12 字节帧头 PTS/长度/标志），视频流剥掉帧头转发 H.264 裸流（与旧前端兼容），音频流提取 Opus 包（含 OpusHead 配置包）加 1 字节类型前缀转发；音频流被设备禁用（Android <11）或出错时自动降级为仅视频并在页面提示
- **前端播放**（`public/receive.html`）：`AudioDecoder` 解码 Opus → `AudioContext` 播放（走 `GainNode` 接电脑扬声器，**声音在电脑端输出，不依赖手机扬声器**）；复用「🔊 声音」按钮静音/取消静音；含播放时钟同步（延迟累积自动重置）
- **单测**：`ScrcpyStreamReader` 4 项（头解析、跨 chunk、会话元数据跳过、半包安全）全部通过

### 新增：连接地址自动缓存与自动连接

- **持久化**（`server/connection-store.js`）：成功连接的 `ip:port` 保存到 `data/last-connection.json`（含手动输入与 mDNS 自动发现两条路径）
- **自动回填/自动连接**（`public/receive.html`）：页面打开或刷新时，服务端下发上次成功地址，自动填入连接输入框并直接发起连接——无需再手动输入地址；自动连接每次页面会话只尝试一次，失败不重复打扰，可随时手动输入覆盖
- **单测**：connection-store 保存/读回/损坏容错 2 项通过

## [v0.2.4] - 2026-11-23

### 修复：scrcpy-server 启动即 `Aborted`（exit code 134）、投屏失败

- **根因**：`adb shell` 拉起 scrcpy-server 的命令缺少 `CLASSPATH` 环境变量。`app_process` 依靠 `CLASSPATH` 定位服务器 jar（`/data/local/tmp/scrcpy-server`）中的类，缺失时找不到 `com.genymobile.scrcpy.Server`，新版 Android 上直接 SIGABRT——表现为仅输出一行 `Aborted` 即退出（code=134），无任何 Java 日志。scrcpy 官方客户端的启动命令本身就带 `CLASSPATH=<jar>` 前缀
- **修复**（`server/adb.js`）：启动命令改为 `adb shell CLASSPATH=/data/local/tmp/scrcpy-server app_process / com.genymobile.scrcpy.Server ...`，与官方一致

### 新增：服务端文件日志（排障必备）

- **`server/logger.js`**：全部无线投屏流程日志（配对/连接/投屏/异常）实时落盘到 `logs/localcast.log`，按大小自动轮转（单文件 2MB，保留 3 份历史）；页面日志刷新即丢失，文件日志供事后排查
- **启动命令落盘**：每次拉起 scrcpy-server 的完整命令行写入日志
- **自动抓取崩溃现场**：scrcpy 启动阶段退出时自动执行 `adb shell logcat -d` 并把其中 scrcpy / AndroidRuntime（Java 崩溃栈）相关行摘录写入文件日志——即使手机端崩溃没有任何 stdout 输出，也能拿到崩溃原因

## [v0.2.3] - 2026-11-23

### 修复：点「开始投屏」后提示「视频通道已断开」

- **根因**：`adb forward` 的本地端口在设备端 socket 就绪**之前**也会接受本地 TCP 连接，随后发现远端（手机上的 scrcpy socket）还没建立就立刻关闭这条连接。旧逻辑把「本地 TCP 连接成功」当作视频通道已建立，切到投屏中状态，紧接着连接被 adb 关闭，于是报「视频通道已断开」并停止
- **修复**（`server/wireless.js`）：通道建立以**收到首个视频数据包**为准——
  - 收到首包前：连接被关闭/出错一律静默重试（最多 20 秒），不再误判为故障
  - 收到首包前到达的数据先缓冲，待状态切换为 streaming 后再投递，避免前端在未进入投屏态时收到码流
- 该修复与 v0.2.2 配合：先解决「探测连接占用 scrcpy 唯一连接名额导致服务端退出」，再解决「本地端口假就绪导致通道误判」

## [v0.2.2] - 2026-11-23

### 修复：点「开始投屏」后 scrcpy-server 立即退出、投屏失败

- **根因**：启动流程中先用「探测连接本地转发端口再销毁」的方式等待就绪——但 scrcpy `tunnel_forward` 模式下服务端只接受**一次**连接（唯一的视频 socket），这次探测把名额占掉后立刻销毁，scrcpy 服务端检测到视频 socket 断开随即退出（表现为 `code=null`），真正的视频连接自然失败并触发停止
- **修复**（`server/wireless.js`）：移除探测逻辑，改为同一个 socket 直连 + 失败重试（最多 20 秒），连上后直接保留为视频通道；重试带防重入保护，避免 error/close 双事件导致重试翻倍
- **启动期快速失败**：scrcpy-server 在连接建立前退出时立即中止重试并报错，不再傻等 20 秒超时
- **日志增强**：scrcpy 的 stdout/stderr 全量逐行转发到页面日志区（此前只取首行且漏掉 stderr），启动失败可直接在页面看到服务端报错原因

## [v0.2.1] - 2026-11-23

### 修复：无线配对按钮「无响应」

- **根因**：`ws` 库的多个 `WebSocketServer` 挂载同一个 HTTP server 时，每个实例都会注册 `upgrade` 监听器，路径不匹配的升级请求会被直接 `abortHandshake(400)` 掐断——`/wireless` 的 WebSocket 握手先被信令服务（`/ws`）的监听器拒绝，导致无线面板按钮发出的消息永远到不了服务端（在已断开的 socket 上 `send` 静默失败，界面无任何反馈）
- **修复**（`server/server.js` / `server/wireless.js`）：信令 WS 与无线 WS 全部改为 `noServer: true`，由统一的 `server.on('upgrade')` 按 pathname 路由（`/ws` → 信令、`/wireless` → 无线），未知路径兜底 `socket.destroy()`，彻底消除多实例互相拒绝握手的问题
- **前端防呆**（`public/receive.html`）：所有按钮改用 `sendSafe` 发送——连接未就绪时在日志区提示「命令未发送」而非静默失败；出现同类问题时用户能立刻看到原因

### 增强：配对流程反馈与容错

- **实时日志**（`server/adb.js`）：`adbStream` 支持逐行流式输出，配对/连接过程中 `adb pair` 的每行输出实时推送页面；配对地址输错时明确提示「必须使用配对弹窗中的地址，而非无线调试主页的地址」
- **自动连接**（`server/wireless.js`）：配对成功后自动轮询 `adb mdns services` 发现 `_adb-tls-connect._tcp` 服务并 `adb connect`（最多 5 次），免去手动抄写 IP:端口；对「已配对」设备直接尝试连接
- **失败恢复**：`fail()` 广播带状态，前端出错时自动收起二维码、恢复按钮可用状态

### 新增：二维码配对（推荐方式，无需手动输入配对码）

- **协议**：遵循 AOSP `adb_wifi` 规范——电脑生成 `WIFI:T:ADB;S:<实例名>;P:<密码>;;` 格式二维码（实例名 `studio-` + 10 位随机字母数字、密码 20 位纯字母数字，规避 WIFI: 串转义）
- **流程**：接收页点「① 扫码配对（推荐）」→ 展示二维码 → 手机相机扫码并在手机上确认「开始配对」→ 服务端每 1.5s 轮询 `adb mdns services`，发现以该实例名广播的 `_adb-tls-pairing._tcp` 服务后自动 `adb pair` → 成功后自动连接；全程 2 分钟有效期，超时/可取消
- **保留**：「② 配对码配对」输入 IP:端口 + 6 位配对码的原方式仍可用
- **单测**：`test/wireless.test.js` 扩充至 15 项（新增 `generateQrPairingSecrets` 载荷校验、`parseMdnsServices` 三列解析/容错/空值安全），全部通过

## [v0.2.0] - 2026-11-23

### 核心修正：Android 浏览器无法投屏的根因与解决

- **根因查明**：「当前版本未启用屏幕采集接口」并非浏览器版本旧或自签名证书问题——Android 平台的**所有**浏览器（Chrome / Edge / 百度 / vivo / UC / 微信等）均未实现 `getDisplayMedia`（Chromium 移动版长期未提供屏幕采集，Chrome 157 仍不支持），升级浏览器、换 Chrome/Edge、忽略证书警告均无法解决；唯一支持该 API 的移动浏览器是 iOS 27+ 的 Safari（MDN / caniuse 2026-11 数据）
- **文案与检测修正**（`public/cast.html`）：不再误导用户「升级浏览器/换 Chrome 即可」；Android 访问时明确说明平台限制并引导使用电脑端「无线投屏」；检测逻辑增加 Android UA 判定与 `isSecureContext` 联合校验
- **文档修正**（`README.md` / `docs/01-技术方案.md`）：浏览器兼容矩阵改为真实数据，移除「Chromium 内核浏览器直接支持」的错误说明

### 新增：无线投屏通道（Android 推荐，无需手机装 App）

- **工具链自动获取**（`server/tools.js`）：自动定位/下载 adb（platform-tools）与 scrcpy-server v5.0.1；多镜像回退（GitHub 官方 + ghfast/gh-proxy/ghproxy 加速 + 腾讯镜像），仅首次下载，缓存在 `tools/` 目录后完全离线；支持 `LOCALCAST_ADB` 环境变量与 PATH 中已有的 adb
- **adb 命令封装**（`server/adb.js`）：无线配对（`adb pair`）、连接（`adb connect`）、mDNS 设备自动发现、端口转发（`adb forward tcp:N localabstract:scrcpy`）、文件推送、scrcpy-server 拉起（`raw_stream=true` 纯 H.264 裸流模式）
- **无线投屏会话**（`server/wireless.js`）：
  - WebSocket 端点 `/wireless`（挂电脑端 HTTP 服务），JSON 控制消息 + 二进制视频流
  - H.264 关键帧缓存（SPS/PPS + 最近 IDR）：页面刷新/中途打开接收页无需等待下一个 GOP 即可出画面
  - 会话状态机（idle/pairing/connecting/ready/streaming）与日志实时推送到页面
- **接收页「无线投屏」面板**（`public/receive.html`）：
  - Tab 切换「扫码/投屏码」与「无线投屏」；配对码输入 → 连接 → 开始/停止投屏
  - WebCodecs（`VideoDecoder`）解码 H.264 Annex-B 裸流，canvas 渲染，等待关键帧期间丢弃 delta 帧避免花屏
  - 配对/连接/投屏全流程日志与状态展示、帧率统计
- **单元测试**（`test/wireless.test.js`）：10 项用例，覆盖关键帧缓存（跨 chunk NAL 识别、IDR 重置、超限保护）、adb 参数校验、镜像列表，`npm test` 全部通过

### 已知限制（v0.2）

- 无线投屏通道需手机开启「开发者选项 → 无线调试」并完成一次配对（Android 11+；Android 10 及以下需 USB 连接）
- 无线通道暂不含声音（scrcpy `audio=false`，音频支持留待后续版本）
- 同一时间仅支持一路无线投屏
- 电脑端接收页的 WebCodecs 解码需 Chrome / Edge 等现代浏览器

## [v0.1.0] - 2026-11-22

### 新增

- **信令服务**（`server/server.js`）：
  - 双端口：8080（HTTP，电脑端）+ 8081（HTTPS，手机端安全上下文）
  - HTTP 服务：静态资源托管、`/api/session` 投屏码与二维码生成接口、本机多地址返回
  - 自签名证书自动生成（node-forge，SAN 含 localhost 与全部本机地址，本机地址变化时自动更新）
  - WebSocket 信令：投屏码会话匹配、两端就绪通知、WebRTC 协商消息（SDP/ICE）转发、断线通知与投屏码失效机制（ws + wss 双挂载）
- **电脑端接收页**（`public/receive.html`）：
  - 6 位投屏码与本地二维码展示、一键刷新
  - 本机所有可用地址芯片列表，点选地址生成对应二维码
  - WebRTC 接收、画面播放、全屏、静音切换、帧率显示
  - 信令状态与投屏状态实时显示、断线自动重连
- **手机端投屏页**（`public/cast.html`）：
  - 扫码/输码自动连接、投屏码回显
  - **浏览器内核识别**：自动区分 Chromium / X5 / WebKit / Gecko 内核，状态区显示识别结果
  - Chrome、Edge、百度浏览器、vivo 浏览器等 Chromium 内核浏览器原生支持，直接投屏
  - 微信/QQ 内置浏览器（X5 内核）给出「在浏览器中打开」针对性引导
  - iOS（Safari/微信，WebKit 内核）明确提示系统限制，引导使用 Android 手机
  - 采集无画面兜底校验，API 存在但采集失败时明确提示并引导换浏览器
  - `getDisplayMedia` 屏幕采集（整个屏幕）、本地预览
  - 复制投屏链接功能：浏览器不支持时一键复制链接，粘贴到目标浏览器打开
  - WebRTC 推流（手机端发起 offer）、通道状态监测、一键停止
- **一键启动**：`start.bat`（Windows 双击运行，含 Node 环境检测、首次依赖安装、防火墙 8080 端口自动放行）
- **端到端自动化测试**（`test/e2e.test.js`）：16 项用例，覆盖 HTTP 接口、投屏码/二维码、信令会话匹配、WebRTC 信令转发、无效码拒绝、断线通知、投屏码失效，`npm test` 全部通过
- **文档**：技术方案（`docs/01-技术方案.md`）、测试验收标准（`docs/02-测试验收标准.md`，含 B-01~B-07 浏览器兼容性验收项）

### 修复

- **HTTPS 安全上下文支持**：手机经 `http://局域网IP` 访问时浏览器不开放 `getDisplayMedia`（此前所有 Chromium 内核浏览器均提示「理论上支持但未启用屏幕采集接口」）。改为双端口设计：8080（HTTP，电脑端，localhost 即安全上下文）+ 8081（HTTPS，手机端，自签名证书首次启动自动生成，SAN 覆盖 localhost 与全部本机地址，首次访问点「继续前往」）；非本机 HTTP 请求 302 跳转 HTTPS；二维码与投屏链接均为 HTTPS 地址
- **start.bat 编码与换行**：批处理改为 UTF-8 + CRLF 并固定 `chcp 65001`，修复 cmd 下中文乱码与「不是内部或外部命令」报错
- **端口占用提示**：服务端新增 EADDRINUSE 友好报错，指引关闭旧实例或更换端口
- **手机端浏览器误判**：不再笼统提示「不支持」，按内核类型给出可操作引导，避免用户在可支持的浏览器上误判

### 已知限制（v0.1）

- 仅支持同一局域网（未配置 STUN/TURN，跨网段不可用）
- 单向投屏（手机 → 电脑），无反向控制与声音投屏
- 投屏码为单会话模型，一对多投屏留待 v2
- iOS（Safari/微信）系统层面不支持屏幕采集，暂不适用，需使用 Android 手机
- 屏幕采集依赖浏览器 `getDisplayMedia` 支持，推荐 Chromium 内核浏览器；手机端需经 HTTPS 访问（首次需确认自签名证书）
