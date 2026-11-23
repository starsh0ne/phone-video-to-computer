/**
 * 工具链管理：adb（platform-tools）与 scrcpy-server 的定位、下载与校验
 *
 * 查找顺序：
 *   adb：环境变量 LOCALCAST_ADB → PATH 中的 adb → tools/platform-tools/adb.exe → 自动下载
 *   scrcpy-server：tools/scrcpy-server → 自动下载（GitHub 多镜像回退）
 *
 * 下载仅首次发生，文件缓存在项目 tools/ 目录，之后完全离线可用。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const ROOT = path.join(__dirname, '..');
const TOOLS_DIR = path.join(ROOT, 'tools');

/** 固定版本：scrcpy-server 与客户端协议强绑定（服务端启动第一个参数必须精确匹配版本号） */
const SCRCPY_VERSION = '5.0.1';
const SCRCPY_SERVER_BASENAME = `scrcpy-server-v${SCRCPY_VERSION}`;

/** 下载镜像列表（依次尝试，全部失败才报错） */
function scrcpyServerUrls() {
  const base = `https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/${SCRCPY_SERVER_BASENAME}`;
  return [
    base,
    `https://ghfast.top/${base}`,
    `https://gh-proxy.com/${base}`,
    `https://ghproxy.net/${base}`,
  ];
}

function platformToolsUrls() {
  // dl.google.com 在国内一般可直连；腾讯镜像作为回退
  const file = process.platform === 'win32' ? 'platform-tools-latest-windows.zip'
    : process.platform === 'darwin' ? 'platform-tools-latest-darwin.zip'
      : 'platform-tools-latest-linux.zip';
  return [
    `https://dl.google.com/android/repository/${file}`,
    `https://mirrors.cloud.tencent.com/AndroidSDK/${file}`,
  ];
}

/* ---------------- 通用工具 ---------------- */

function adbBinaryName() {
  return process.platform === 'win32' ? 'adb.exe' : 'adb';
}

function scrcpyServerPath() {
  return path.join(TOOLS_DIR, 'scrcpy-server');
}

function localPlatformToolsAdb() {
  return path.join(TOOLS_DIR, 'platform-tools', adbBinaryName());
}

/** 执行命令，返回 { code, stdout, stderr } */
function runCapture(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timer = null;
    const finish = (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    if (timeoutMs) {
      timer = setTimeout(() => {
        try { child.kill(); } catch {}
        finish(-1);
      }, timeoutMs);
    }
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => { stderr += String(err.message); finish(-1); });
    child.on('close', (code) => finish(code));
  });
}

/* ---------------- 下载 ---------------- */

/** 用 Node fetch 下载文件到指定路径（流式写入，支持重定向） */
async function downloadTo(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}

/** 依次尝试镜像列表下载；成功返回所用 URL，全部失败抛错 */
async function downloadWithMirrors(urls, dest, onProgress) {
  const errors = [];
  for (const url of urls) {
    try {
      onProgress && onProgress(`正在下载 ${url}`);
      const tmp = dest + '.download';
      await downloadTo(url, tmp);
      const size = fs.statSync(tmp).size;
      if (size < 1024) throw new Error(`文件过小(${size}B)，可能不是有效文件`);
      fs.renameSync(tmp, dest);
      return url;
    } catch (err) {
      errors.push(`${url} -> ${err.message}`);
      try { fs.unlinkSync(dest + '.download'); } catch {}
    }
  }
  throw new Error('所有下载源均失败：\n  ' + errors.join('\n  '));
}

/** 解压 zip 到目标目录（Windows 用 PowerShell，其他平台用系统 tar） */
async function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  let res;
  if (process.platform === 'win32') {
    res = await runCapture('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${destDir}" -Force`,
    ], 180000);
  } else {
    res = await runCapture('tar', ['-xf', zipPath, '-C', destDir], 180000);
  }
  if (res.code !== 0) throw new Error('解压失败: ' + (res.stderr || res.stdout).slice(0, 300));
}

/* ---------------- 对外接口 ---------------- */

/**
 * 定位可用的 adb。优先已存在的（PATH / tools 目录），否则自动下载 platform-tools。
 * 返回 { adbPath, downloaded }
 */
async function ensureAdb(log) {
  const info = (m) => log && log(m);

  // 1. 环境变量显式指定
  if (process.env.LOCALCAST_ADB) {
    if (fs.existsSync(process.env.LOCALCAST_ADB)) {
      return { adbPath: process.env.LOCALCAST_ADB, downloaded: false };
    }
    info(`[工具链] LOCALCAST_ADB 指向的文件不存在：${process.env.LOCALCAST_ADB}，忽略`);
  }

  // 2. PATH 中的 adb
  const pathCheck = await runCapture(
    process.platform === 'win32' ? 'where' : 'which',
    [adbBinaryName()],
    10000,
  );
  if (pathCheck.code === 0 && pathCheck.stdout.trim()) {
    const p = pathCheck.stdout.trim().split(/\r?\n/)[0];
    info(`[工具链] 使用系统已安装的 adb：${p}`);
    return { adbPath: p, downloaded: false };
  }

  // 3. tools/platform-tools 本地缓存
  if (fs.existsSync(localPlatformToolsAdb())) {
    return { adbPath: localPlatformToolsAdb(), downloaded: false };
  }

  // 4. 自动下载
  info('[工具链] 未找到 adb，开始自动下载 platform-tools（仅首次，之后离线可用）…');
  const zipPath = path.join(TOOLS_DIR, 'platform-tools.zip');
  fs.mkdirSync(TOOLS_DIR, { recursive: true });
  const used = await downloadWithMirrors(platformToolsUrls(), zipPath, (m) => info(`[工具链] ${m}`));
  info(`[工具链] 下载完成（源：${used.split('/').slice(2, 3)[0]}），正在解压…`);
  await extractZip(zipPath, TOOLS_DIR);
  fs.unlinkSync(zipPath);
  if (!fs.existsSync(localPlatformToolsAdb())) {
    throw new Error('解压后未找到 adb，请手动下载 platform-tools 解压到 tools/ 目录');
  }
  return { adbPath: localPlatformToolsAdb(), downloaded: true };
}

/**
 * 定位 scrcpy-server。返回文件路径；不存在时自动下载（多镜像）。
 */
async function ensureScrcpyServer(log) {
  const info = (m) => log && log(m);
  const dest = scrcpyServerPath();
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1024) {
    return dest;
  }
  info(`[工具链] 开始自动下载 scrcpy-server v${SCRCPY_VERSION}（仅首次，之后离线可用）…`);
  fs.mkdirSync(TOOLS_DIR, { recursive: true });
  const used = await downloadWithMirrors(scrcpyServerUrls(), dest, (m) => info(`[工具链] ${m}`));
  info(`[工具链] scrcpy-server 下载完成（源：${used.split('/').slice(2, 3)[0]}）`);
  return dest;
}

module.exports = {
  TOOLS_DIR,
  SCRCPY_VERSION,
  ensureAdb,
  ensureScrcpyServer,
  scrcpyServerPath,
  // 导出纯逻辑便于测试
  scrcpyServerUrls,
  platformToolsUrls,
};
