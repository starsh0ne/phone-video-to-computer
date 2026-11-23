/**
 * 连接状态持久化：记住上一次成功连接的手机地址（adb connect 用的 ip:port），
 * 重启服务/刷新页面后自动回填并自动重连。
 * 存储位置：data/last-connection.json（写入失败静默忽略，不影响主流程）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
// 允许测试通过环境变量把存储指到临时文件：测试绝不能写真实缓存
// （v0.6.7 之前测试直写 data/last-connection.json，把用户缓存的最新地址覆盖回测试样例 38051，
//  导致自动回填一直连旧端口——样例地址恰好与用户旧端口重合，极具迷惑性）
const FILE = process.env.LC_CONNECTION_FILE || path.join(DATA_DIR, 'last-connection.json');

function load() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj.addr === 'string' && /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(obj.addr)) {
      return { addr: obj.addr, savedAt: obj.savedAt || 0 };
    }
  } catch { /* 无文件或损坏：忽略 */ }
  return null;
}

function save(addr) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({ addr, savedAt: Date.now() }, null, 2), 'utf8');
  } catch { /* 写失败不影响主流程 */ }
}

module.exports = { load, save, FILE };
