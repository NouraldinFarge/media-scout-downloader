const textEncoder = new TextEncoder();
const crcTable = buildCrcTable();

/**
 * Creates a small standards-compliant ZIP Blob with uncompressed text files.
 * This avoids external libraries/CDNs and keeps report generation local.
 */
export function createZipBlob(files = []) {
  const entries = normalizeZipEntries(files);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of entries) {
    const name = file.path;
    const nameBytes = textEncoder.encode(name);
    const dataBytes = toBytes(file.content ?? '');
    const crc = crc32(dataBytes);
    const mod = dosDateTime(new Date());

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const local = new DataView(localHeader.buffer);
    writeUint32(local, 0, 0x04034b50);
    writeUint16(local, 4, 20);
    writeUint16(local, 6, 0x0800);
    writeUint16(local, 8, 0);
    writeUint16(local, 10, mod.time);
    writeUint16(local, 12, mod.date);
    writeUint32(local, 14, crc);
    writeUint32(local, 18, dataBytes.length);
    writeUint32(local, 22, dataBytes.length);
    writeUint16(local, 26, nameBytes.length);
    writeUint16(local, 28, 0);
    localHeader.set(nameBytes, 30);
    localParts.push(localHeader, dataBytes);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const central = new DataView(centralHeader.buffer);
    writeUint32(central, 0, 0x02014b50);
    writeUint16(central, 4, 20);
    writeUint16(central, 6, 20);
    writeUint16(central, 8, 0x0800);
    writeUint16(central, 10, 0);
    writeUint16(central, 12, mod.time);
    writeUint16(central, 14, mod.date);
    writeUint32(central, 16, crc);
    writeUint32(central, 20, dataBytes.length);
    writeUint32(central, 24, dataBytes.length);
    writeUint16(central, 28, nameBytes.length);
    writeUint16(central, 30, 0);
    writeUint16(central, 32, 0);
    writeUint16(central, 34, 0);
    writeUint16(central, 36, 0);
    writeUint32(central, 38, 0);
    writeUint32(central, 42, offset);
    centralHeader.set(nameBytes, 46);
    centralParts.push(centralHeader);

    offset += localHeader.length + dataBytes.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  writeUint32(endView, 0, 0x06054b50);
  writeUint16(endView, 4, 0);
  writeUint16(endView, 6, 0);
  writeUint16(endView, 8, entries.length);
  writeUint16(endView, 10, entries.length);
  writeUint32(endView, 12, centralSize);
  writeUint32(endView, 16, offset);
  writeUint16(endView, 20, 0);

  return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
}

export function normalizeZipEntries(files = []) {
  const used = new Set();
  return (Array.isArray(files) ? files : []).slice(0, 256).map((file, index) => {
    const fallback = `report-${index + 1}.txt`;
    const originalPath = file?.path || file?.name || fallback;
    let path = sanitizeZipPath(originalPath, fallback);
    let suffix = 2;
    while (used.has(path.toLowerCase())) {
      path = addPathSuffix(sanitizeZipPath(originalPath, fallback), suffix);
      suffix += 1;
    }
    used.add(path.toLowerCase());
    return { path, content: file?.content ?? '' };
  });
}

function toBytes(content) {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  return textEncoder.encode(String(content));
}

export function sanitizeZipPath(path, fallback = 'report.txt') {
  const segments = String(path || '')
    .replace(/\\/g, '/')
    .split('/')
    .map(sanitizeZipSegment)
    .filter((segment) => segment && segment !== '.' && segment !== '..');
  const safeFallback = sanitizeZipSegment(fallback) || 'report.txt';
  return segments.join('/').slice(0, 180) || safeFallback;
}

function sanitizeZipSegment(segment) {
  let value = String(segment || '')
    .replace(/[\u0000-\u001f\u007f<>:"|?*]+/g, '-')
    .trim()
    .replace(/[. ]+$/g, '');
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) value = `_${value}`;
  return value;
}

function addPathSuffix(path, suffix) {
  const slash = path.lastIndexOf('/');
  const directory = slash >= 0 ? path.slice(0, slash + 1) : '';
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot) : '';
  const stem = `${directory}${dot > 0 ? name.slice(0, dot) : name}`;
  const marker = `-${suffix}`;
  const maxStemLength = Math.max(1, 180 - marker.length - extension.length);
  return `${stem.slice(0, maxStemLength)}${marker}${extension}`;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  return { date: dosDate, time: dosTime };
}

function writeUint16(view, offset, value) {
  view.setUint16(offset, value & 0xffff, true);
}

function writeUint32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}
