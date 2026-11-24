/**
 * 二维码配对密钥材料生成（AOSP adb_wifi 协议的客户端侧）：
 * 电脑生成 `WIFI:T:ADB;S:studio-XXXX;P:密码;;` 二维码 → 手机扫码后以指定服务名启动配对服务
 * → 电脑通过 adb mdns services 发现该服务 → adb pair <ip:port> <密码> → 自动连接。
 */
'use strict';

const crypto = require('crypto');

/** 生成二维码配对密钥材料：服务实例名 + 配对密码（纯字母数字，规避 WIFI: 串转义问题） */
function generateQrPairingSecrets() {
  const alnum = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const pick = (n) => Array.from(crypto.randomBytes(n))
    .map((b) => alnum[b % alnum.length]).join('');
  const instance = 'studio-' + pick(10);
  const password = pick(20);
  return { instance, password, qrString: `WIFI:T:ADB;S:${instance};P:${password};;` };
}

module.exports = { generateQrPairingSecrets };
