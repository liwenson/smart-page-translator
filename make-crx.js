// 手动创建CRX文件 (简化版)
// 运行: node make-crx.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const distDir = path.join(__dirname, 'dist');
const outputFile = path.join(__dirname, 'smart-page-translator-v2.1.0.crx');

// 读取zip文件
const zipFile = path.join(__dirname, 'smart-page-translator-v2.1.0.zip');
if (!fs.existsSync(zipFile)) {
    console.error('错误: 请先创建zip文件');
    console.log('运行: powershell -Command "Compress-Archive -Path dist/* -DestinationPath smart-page-translator-v2.1.0.zip"');
    process.exit(1);
}

const zipData = fs.readFileSync(zipFile);

// CRX2文件格式:
// - Magic: 'Cr24' (4 bytes)
// - Version: 2 (4 bytes LE)
// - Header Length (4 bytes LE)  
// - Public Key Length (4 bytes LE)
// - Archive Length (4 bytes LE)
// - Public Key (variable)
// - Archive Data (zip content)

// 使用一个空的公钥（未签名版本）
const publicKey = Buffer.alloc(0);

// 构建CRX文件
const magic = Buffer.from('Cr24');
const version = Buffer.alloc(4);
version.writeUInt32LE(2, 0);  // CRX format version 2

const headerLen = Buffer.alloc(4);
headerLen.writeUInt32LE(0, 0);  // No header

const pubkeyLen = Buffer.alloc(4);
pubkeyLen.writeUInt32LE(publicKey.length, 0);

const archiveLen = Buffer.alloc(4);
archiveLen.writeUInt32LE(zipData.length, 0);

const crx = Buffer.concat([
    magic,
    version,
    headerLen,
    pubkeyLen,
    archiveLen,
    publicKey,
    zipData
]);

fs.writeFileSync(outputFile, crx);

console.log('CRX文件已创建:', outputFile);
console.log('文件大小:', (crx.length / 1024).toFixed(2), 'KB');
console.log('\n注意: 此CRX文件未签名，可能需要在Chrome中启用开发者模式');
