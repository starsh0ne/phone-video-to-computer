/**
 * 服务端文件日志：所有无线投屏流程日志（配对/连接/scrcpy/异常）落盘到 logs/localcast.log，
 * 便于事后排查问题（页面日志刷新即丢失）。
 * - 按大小轮转：单文件 2MB，最多保留 3 个历史（localcast.log.1 ~ .3）
 * - 写失败静默忽略，绝不影响主流程
 */
'use strict';

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'localcast.log');
const MAX_SIZE = 2 * 1024 * 1024; // 2MB
const MAX_FILES = 3;

function ensureDir() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
}

function rotateIfNeeded() {
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size < MAX_SIZE) return;
    // 依次向后滚动：.2 -> .3, .1 -> .2, 主文件 -> .1
    for (let i = MAX_FILES - 1; i >= 1; i--) {
      const from = `${LOG_FILE}.${i}`;
      const to = `${LOG_FILE}.${i + 1}`;
      if (fs.existsSync(from)) {
        if (i === MAX_FILES - 1) fs.unlinkSync(from); // 最旧的直接删除
        else fs.renameSync(from, to);
      }
    }
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch { /* 首次运行或文件不存在，忽略 */ }
}

function write(level, message) {
  ensureDir();
  rotateIfNeeded();
  const ts = new Date().toLocaleString('sv-SE', { hour12: false }); // 2026-11-23 20:15:42
  const text = String(message).replace(/\r?\n$/, '');
  // 多行消息：首行带时间戳，后续行缩进对齐
  const lines = text.split(/\r?\n/).map((l, i) => (i === 0 ? `${ts} [${level}] ${l}` : `           | ${l}`));
  try { fs.appendFileSync(LOG_FILE, lines.join('\n') + '\n', 'utf8'); } catch {}
}

module.exports = {
  info: (msg) => write('INFO', msg),
  error: (msg) => write('ERROR', msg),
  LOG_FILE,
};
