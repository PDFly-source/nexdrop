const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Generate uncompressed/deflated raw RGBA PNG
function createPng(width, height, r, g, b) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData.writeUInt8(8, 8); // bit depth
  ihdrData.writeUInt8(6, 9); // color type RGBA
  ihdrData.writeUInt8(0, 10); // compression
  ihdrData.writeUInt8(0, 11); // filter
  ihdrData.writeUInt8(0, 12); // interlace

  const ihdrChunk = createChunk('IHDR', ihdrData);

  // Raw scanlines: width * 4 + 1 filter byte per line
  const rawScanlines = Buffer.alloc((width * 4 + 1) * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    rawScanlines.writeUInt8(0, pos++); // Filter None
    for (let x = 0; x < width; x++) {
      // Draw subtle dark background with emerald center square
      const isCenter =
        x > width * 0.35 && x < width * 0.65 &&
        y > height * 0.35 && y < height * 0.65;
      
      const pr = isCenter ? 25 : r;
      const pg = isCenter ? 195 : g;
      const pb = isCenter ? 125 : b;

      rawScanlines.writeUInt8(pr, pos++);
      rawScanlines.writeUInt8(pg, pos++);
      rawScanlines.writeUInt8(pb, pos++);
      rawScanlines.writeUInt8(255, pos++);
    }
  }

  const deflated = zlib.deflateSync(rawScanlines);
  const idatChunk = createChunk('IDAT', deflated);
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function createChunk(type, data) {
  const length = data.length;
  const buffer = Buffer.alloc(8 + length + 4);
  buffer.writeUInt32BE(length, 0);
  buffer.write(type, 4, 4, 'ascii');
  data.copy(buffer, 8);
  const crc = crc32(buffer.subarray(4, 8 + length));
  buffer.writeUInt32BE(crc, 8 + length);
  return buffer;
}

// Standard CRC32
function crc32(buf) {
  let table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  let crc = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

const iconsDir = path.join(__dirname, '../public/icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

// NexDrop deep background #0B0D0F -> (11, 13, 15)
fs.writeFileSync(path.join(iconsDir, 'icon-192.png'), createPng(192, 192, 11, 13, 15));
fs.writeFileSync(path.join(iconsDir, 'icon-512.png'), createPng(512, 512, 11, 13, 15));
fs.writeFileSync(path.join(iconsDir, 'icon-maskable-512.png'), createPng(512, 512, 11, 13, 15));
fs.writeFileSync(path.join(__dirname, '../public/apple-touch-icon.png'), createPng(180, 180, 11, 13, 15));

console.log('PWA PNG Icons generated successfully.');
