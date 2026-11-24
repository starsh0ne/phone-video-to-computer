/**
 * 自签名 HTTPS 证书（node-forge）：
 * 确保证书存在且与当前本机地址匹配；本机地址变化时重新生成，
 * SAN 覆盖 localhost + 全部本机 IPv4，尽量让手机端少报证书警告。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const forge = require('node-forge');
const { CERT_DIR, getLanIPs } = require('./config');

function ensureCert() {
  const keyPath = path.join(CERT_DIR, 'key.pem');
  const certPath = path.join(CERT_DIR, 'cert.pem');
  const ipsPath = path.join(CERT_DIR, 'ips.json');
  const currentIPs = getLanIPs();

  let needGenerate = true;
  if (fs.existsSync(keyPath) && fs.existsSync(certPath) && fs.existsSync(ipsPath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(ipsPath, 'utf8'));
      needGenerate = (saved.ips || []).join(',') !== currentIPs.join(',');
    } catch {
      needGenerate = true;
    }
  }
  if (!needGenerate) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }

  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  const attrs = [{ name: 'commonName', value: 'local-cast' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  // SAN：localhost + 全部本机地址，尽量让浏览器少报证书错误
  const altNames = [{ type: 2, value: 'localhost' }];
  currentIPs.forEach((ip) => altNames.push({ type: 7, ip }));
  cert.setExtensions([{ name: 'subjectAltName', altNames }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(keyPath, forge.pki.privateKeyToPem(keys.privateKey));
  fs.writeFileSync(certPath, forge.pki.certificateToPem(cert));
  fs.writeFileSync(ipsPath, JSON.stringify({ ips: currentIPs, createdAt: Date.now() }));
  console.log('[证书] 已生成自签名证书（certs/ 目录），手机首次访问 HTTPS 需点「继续前往」');
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

module.exports = { ensureCert };
