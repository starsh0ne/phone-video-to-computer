# 架构文档（v0.7.1 结构重构后）

> 本文描述代码结构与数据流。改代码前先看「常见修改入口」速查表。
> 原则：**零构建依赖**（start.bat 直跑 node，前端纯静态文件）；改功能前先读对应模块的注释——
> 大量关键时序/兼容性知识写在代码注释里（如 socket 建立顺序、WebCodecs 配置时序），勿删。

## 目录结构

```
投屏/
├── start.bat                  # 启动入口（node server/index.js）
├── server/                    # 服务端（CommonJS，无构建）
│   ├── index.js               # 进程入口：HTTP/HTTPS 装配、静态路由、upgrade 分发、SIGINT
│   ├── config.js              # 端口/目录/MIME/本机地址探测
│   ├── logger.js              # 文件日志（logs/localcast.log）+ 控制台
│   ├── cert.js                # 自签名证书生成（node-forge，SAN 覆盖本机全部 IPv4）
│   ├── cast-code.js           # 投屏码会话：6 位码 + WebRTC 信令转发（iOS Safari 直投通道）
│   ├── adb.js                 # adb 命令封装（pair/connect/devices/mdns/forward/push/shell/scrcpy 启动）
│   ├── tools.js               # 工具链下载（platform-tools / scrcpy-server，含镜像回退）
│   ├── connection-store.js    # 最近一次成功连接地址持久化（data/last-connection.json，
│   │                          #   测试用 LC_CONNECTION_FILE 环境变量隔离——勿在测试里直写真实文件）
│   └── wireless/              # 无线投屏通道（ADB + scrcpy）
│       ├── index.js           # 门面：保持 require('../server/wireless') 兼容
│       ├── session.js         # 会话生命周期状态机（连接/开流/停止/亮屏保持/双 socket 建立）
│       ├── stream-reader.js   # scrcpy 线格式解析 + 编码器常量（纯逻辑）
│       ├── keyframe-cache.js  # 关键帧缓存：新客户端免等 GOP（纯逻辑）
│       ├── pairing.js         # 二维码配对密钥生成（纯逻辑）
│       ├── stall-policy.js    # 停滞降载阶梯与熔断（纯策略，可单测）
│       └── ws-endpoint.js     # /wireless WS 路由、消息分发、崩溃兜底
├── public/
│   ├── receive.html           # 电脑端接收页骨架（114 行，样式与脚本已外置）
│   ├── cast.html              # 手机端投屏页（iOS WebRTC 采集）
│   ├── css/receive.css        # 接收页样式
│   └── js/
│       ├── receive.js         # 接收页主脚本（UI/WS/H.264 状态机/解码器/看门狗）
│       ├── audio-worker.js    # 音频解码 Worker（Opus → PCM，主线程零参与）
│       └── audio-worklet.js   # 环形缓冲播放 Worklet（单一连续播放时钟）
├── test/
│   ├── e2e.test.js            # 起真实服务进程打 HTTP/WS（16 项）
│   ├── wireless.test.js       # 单元：协议解析/配对/缓存/连接存储（21 项）
│   └── stall-policy.test.js   # 单元：停滞阶梯/熔断（7 项）
├── docs/                      # 设计文档（01-技术方案.md 等）
├── data/                      # 运行时数据（last-connection.json，勿提交含真实地址的改动）
├── logs/                      # 运行日志（localcast.log）
└── certs/                     # 自签名证书（自动生成）
```

## 数据流

### 无线投屏（Android，主通道）

```
手机 scrcpy-server（采集+H.264/Opus 编码）
   │  adb forward 隧道（video→audio 两条 socket，时序约束见 session.js 注释）
   ▼
server/wireless/session.js ── ScrcpyStreamReader 剥帧 ── KeyframeCache 引导缓存
   │                                              │
   ▼ WebSocket /wireless 二进制广播                ▼ 新客户端接入时先发 bootstrap
public/js/receive.js
   ├─ H.264 Annex-B 状态机（NAL 切分 → SPS/PPS 缓存 → 关键帧处理）
   ├─ WebCodecs VideoDecoder（按 SPS 真实 profile/level 配置）
   ├─ 呈现：presentFrame + rAF/定时器兜底（paintScheduled 单一标记）
   └─ 看门狗：⓪渲染兜底 ①解码重建 ②采集重启(需手机在播) ③升级重启 ④页面自刷新
        （阶梯/熔断判定在 server/wireless/stall-policy.js）

音频：WS → audio-worker.js（Worker 内 Opus 解码）→ MessageChannel 直达
      audio-worklet.js 环形缓冲（worker→worklet 端口转移所有权，主线程零参与）
```

### 网页直投（iOS 27+ Safari）

```
电脑接收页 ── GET /api/session ──► cast-code.js 生成投屏码+二维码
两端 ── WS /ws join/signal ──► WebRTC 协商转发 ──► 媒体流 P2P 直连（不经服务）
手机端页面：public/cast.html（getDisplayMedia 采集）
```

## 关键不变量（改代码前必读）

1. **scrcpy 双 socket 时序**：视频 socket 必须先确认（send_dummy_byte）再连音频，否则死锁——详见 `session.js` 开流段落注释。
2. **视频/音频二进制区分**：音频帧前缀 `'C'/'P'`（0x43/0x50），视频无前缀。改协议需两端同步。
3. **解码器必须按 SPS 真实规格配置**（`avc1.PPCCLL`），默认 42E01F 会导致部分硬件解码器对 1080p60 静默卡死（v0.6.6 教训）。
4. **测试绝不写真实 `data/last-connection.json`**（用 LC_CONNECTION_FILE 隔离，v0.6.8 教训：测试样例地址污染用户缓存导致回填旧端口）。
5. **前端 `paintScheduled` 是单一排队标记**，rAF 挂起时由看门狗⓪用定时器强制上屏——不要改回双标记。
6. **worker 解码就绪前到达的 OpusHead 配置包必须缓存补发**（时序坑，v0.5.x 系列教训）。

## 常见修改入口速查

| 要改什么 | 去哪 |
|---|---|
| 服务端口 / 静态目录 | `server/config.js` |
| scrcpy 启动参数（码率/帧率/编码器） | `server/adb.js` startScrcpyServer + `stall-policy.js` 阶梯 |
| 停滞自愈的判定与阈值 | 前端看门狗 `public/js/receive.js`（①②③④）；服务端阶梯 `stall-policy.js` |
| WS 消息协议（新增消息类型） | `server/wireless/ws-endpoint.js` + `public/js/receive.js` onmessage |
| 连接缓存行为 | `server/connection-store.js` + `session.js` 的 connect/tryAutoConnect |
| 前端音频链路 | `public/js/audio-worker.js`（解码）+ `audio-worklet.js`（播放）+ receive.js 音频段 |
| 静态文件 MIME | `server/config.js` MIME 表 |

## 测试

```
npm test   # e2e(16) + 单元(21) + 停滞策略(7)
```
- e2e 会真实启动 `server/index.js`（随机端口）打 HTTP/WS；
- 单元测试不依赖 adb/网络/设备；
- 新增纯逻辑模块时，参照 stall-policy.test.js 的装配器格式（tests 数组 + test() + 顺序执行）。

## 后续演进方向（本次未做）

- `public/js/receive.js`（1162 行）内 UI / WS / 解码器 / 看门狗共享闭包状态，
  进一步拆分需引入共享状态命名空间（App.*），建议在下次功能迭代时顺带完成；
- H.265 编码支持（同画质码率减半，需验证浏览器 HEVC WebCodecs 解码）；
- 视频链路整体 Worker 化（WS+解析+解码+OffscreenCanvas 绘制全部离开主线程）；
- 反向控制完整化（键鼠操控手机、剪贴板同步——控制通道已随熄屏投屏建立）；
- H.265/AV1 编码与按机型编码器探测（list_encoders 设备档案）。
