/**
 * 全局配置与环境探测：端口、目录、MIME 表、本机地址。
 * 改端口/路径只动这里。
 */
'use strict';

const path = require('path');
const os = require('os');

/** 服务端口（可用环境变量 PORT_HTTP / PORT_HTTPS 覆盖） */
const PORT_HTTP = Number(process.env.PORT_HTTP) || 8080;
const PORT_HTTPS = Number(process.env.PORT_HTTPS) || 8081;

/** 静态资源与证书目录 */
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const CERT_DIR = path.join(__dirname, '..', 'certs');

/** 静态文件扩展名 → Content-Type 映射 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** 获取本机所有非内部 IPv4 地址（Wi-Fi、热点等所有可被外部访问的地址） */
function getLanIPs() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

/** 获取本机第一个非内部 IPv4 地址（默认主地址） */
function getLanIP() {
  const ips = getLanIPs();
  return ips.length ? ips[0] : '127.0.0.1';
}

module.exports = { PORT_HTTP, PORT_HTTPS, PUBLIC_DIR, CERT_DIR, MIME, getLanIPs, getLanIP };
