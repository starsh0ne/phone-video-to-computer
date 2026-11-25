/**
 * 视频流停滞的降载阶梯与熔断策略（纯函数，无副作用，可单测）。
 *
 * 输入：10 分钟窗口内的停滞时刻数组 + 当前开流参数，输出：是否重启、新参数、要广播的消息。
 * 阶梯（每级只升不降，手动停止后重新开始投屏即重置）：
 *   10 分钟内第 1 次  → 仅重启会话（秒级恢复）
 *   ≥ 2 次           → 切换 Android 自带软件编码器 c2.android.avc.encoder + 30fps + 6Mbps
 *                      （实测：停滞在 Wi-Fi 与 USB 传输上同等出现且码率无关——是 vivo 硬件
 *                      编码器/投影路径被系统冻结，降码率无效，直接换软件编码器）
 *   > 5 次           → 熔断：暂停自动重启。反复重建 MediaProjection 会话会刺激
 *                      vivo 等系统进一步限流，越重启越糟；提示用户手动介入
 */
'use strict';

const STALL_WINDOW_MS = 10 * 60 * 1000;   // 停滞统计窗口
const MAX_RESTARTS_PER_WINDOW = 5;        // 窗口内自动重启上限（超过即熔断）
const RESTART_MIN_GAP_MS = 30 * 1000;     // 两次自动重启的最小间隔

/** 软件编码器：Android 12+ 全设备内置（CDD 要求），绕开厂商硬件编码器问题 */
const SOFTWARE_ENCODER = 'c2.android.avc.encoder';

/**
 * @param {number[]} stallTimes 历史停滞时刻（Date.now 基准）
 * @param {object}   options    当前开流参数（bitrate/maxSize/maxFps/videoEncoder…）
 * @param {number}   now        本次停滞时刻
 * @returns {{ restart: boolean, stallTimes: number[], restartOpts: object, messages: string[] }}
 */
function planStallRestart({ stallTimes, options, now }) {
  const times = (stallTimes || []).filter((t) => now - t < STALL_WINDOW_MS);
  times.push(now);
  const opts = { ...options };
  const n = times.length;
  const messages = [];

  if (n > MAX_RESTARTS_PER_WINDOW) {
    messages.push(
      '⚠ 10 分钟内已自动重启 ' + MAX_RESTARTS_PER_WINDOW + ' 次仍未稳定：手机端采集正被系统反复中断，' +
      '已暂停自动重启（避免投影会话反复重建加重限流）。请点「停止投屏」再重新开始（重置计数）；' +
      '持续如此建议手机插线使用或检查省电策略'
    );
    return { restart: false, stallTimes: times, restartOpts: opts, messages };
  }

  if (n >= 2 && opts.screenOff) {
    // 实测（v0.7.9 真机）：熄屏状态下 vivo 显示管线 ~50s 后停止渲染（比亮屏的 ~90s 更快），
    // 与编码器类型/传输介质无关 → 第一优先级对策：关闭熄屏、点亮手机屏幕重试
    opts.screenOff = false;
    messages.push(
      '⚠ 熄屏投屏下视频停滞（实测 vivo 熄屏后显示管线约 1 分钟内停止渲染）：' +
      '已自动关闭熄屏并点亮手机屏幕重试；若不想手机亮屏，仅能接受周期性自动重启'
    );
    return { restart: true, stallTimes: times, restartOpts: opts, messages };
  }

  if (n >= 2 && !opts.videoEncoder) {
    opts.videoEncoder = SOFTWARE_ENCODER;
    opts.bitrate = Math.min(opts.bitrate || 6000000, 6000000);
    opts.maxFps = 30;
    messages.push(
      '⚠ 视频流再次停滞：疑似手机硬件编码器/采集路径被系统冻结（USB/Wi-Fi 均同现，与码率无关），' +
      '已切换软件编码器（更稳，帧率降至 30fps）。若软件编码器仍频繁停滞，则 vivo 在挂起整个采集会话，' +
      '建议检查手机省电/隐私权限策略'
    );
  }

  return { restart: true, stallTimes: times, restartOpts: opts, messages };
}

module.exports = {
  planStallRestart,
  STALL_WINDOW_MS,
  MAX_RESTARTS_PER_WINDOW,
  RESTART_MIN_GAP_MS,
  SOFTWARE_ENCODER,
};
