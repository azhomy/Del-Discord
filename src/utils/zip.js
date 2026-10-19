import { RunStoppedError } from '../discord/api.js';
import { sleep } from './timing.js';

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  for (let bit = 0; bit < 8; bit++) index = (index >>> 1) ^ ((index & 1) ? 0xedb88320 : 0);
  return index;
});

export class ZipCapacityError extends Error {
  constructor(message) { super(message); this.name = 'ZipCapacityError'; }
}

const checkCapacity = (count, size) => {
  if (count >= 65535) throw new ZipCapacityError('Too many files for one ZIP. Export fewer conversations or a smaller date range.');
  if (size >= 0xffffffff) throw new ZipCapacityError('ZIP exceeds 4 GB. Export fewer conversations or a smaller date range.');
};

const zipPath = (name, size) => {
  if (!name || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid ZIP file path.');
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid ZIP file size.');
  const path = new TextEncoder().encode(name);
  if (path.length > 65535 || size >= 0xffffffff) throw new ZipCapacityError('ZIP exceeds 4 GB. Export fewer conversations or a smaller date range.');
  return path;
};

// Reserve the two metadata files, then update their sizes as conversations are
// serialized. Attachment downloads can check capacity before reading a body.
export function createZipBudget() {
  const entries = new Map();
  let size = 22;
  const checkFile = (name, bytes) => {
    const previous = entries.get(name);
    const entrySize = 76 + 2 * zipPath(name, bytes).length + bytes;
    const nextSize = size - (previous ?? 0) + entrySize;
    checkCapacity(entries.size + (previous === undefined ? 1 : 0), nextSize);
    return { entrySize, nextSize };
  };
  return {
    checkFile(name, bytes) { checkFile(name, bytes); },
    setFile(name, bytes) {
      const { entrySize, nextSize } = checkFile(name, bytes);
      entries.set(name, entrySize); size = nextSize;
    },
  };
}

// Stored ZIP entries keep already-compressed media intact. Read small slices
// for checksums rather than holding another copy of every attachment in memory.
export async function filesToZip(files, stopCheck = () => false) {
  const check = () => { if (stopCheck()) throw new RunStoppedError(); };
  check();
  checkCapacity(files.length, 22);
  // Validate the whole archive before reading/checksumming any payloads.
  const paths = [];
  let archiveSize = 22, yieldedAt = performance.now();
  for (const { name, blob } of files) {
    check();
    const path = zipPath(name, blob.size);
    paths.push(path);
    archiveSize += 76 + 2 * path.length + blob.size;
    checkCapacity(files.length, archiveSize);
    if (performance.now() - yieldedAt >= 8) { await sleep(0); check(); yieldedAt = performance.now(); }
  }
  const parts = [], central = [];
  let offset = 0, centralSize = 0;
  for (const [index, { blob }] of files.entries()) {
    check();
    const path = paths[index];
    let crc = 0xffffffff;
    for (let start = 0; start < blob.size; start += 65536) {
      check();
      const bytes = new Uint8Array(await blob.slice(start, start + 65536).arrayBuffer());
      for (let index = 0; index < bytes.length; index++) crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[index]) & 255];
      if (performance.now() - yieldedAt >= 8) { await sleep(0); check(); yieldedAt = performance.now(); }
    }
    check(); crc = (crc ^ 0xffffffff) >>> 0;
    const local = new Uint8Array(30), localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true); localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x800, true); localView.setUint16(12, 33, true); // UTF-8, Jan 1 1980
    localView.setUint32(14, crc, true); localView.setUint32(18, blob.size, true);
    localView.setUint32(22, blob.size, true); localView.setUint16(26, path.length, true);
    const entry = new Uint8Array(46), view = new DataView(entry.buffer);
    view.setUint32(0, 0x02014b50, true); view.setUint16(4, 20, true); view.setUint16(6, 20, true);
    view.setUint16(8, 0x800, true); view.setUint16(14, 33, true);
    view.setUint32(16, crc, true); view.setUint32(20, blob.size, true); view.setUint32(24, blob.size, true);
    view.setUint16(28, path.length, true); view.setUint32(42, offset, true);
    parts.push(local, path, blob); central.push(entry, path);
    offset += local.length + path.length + blob.size; centralSize += entry.length + path.length;
    if (performance.now() - yieldedAt >= 8) { await sleep(0); check(); yieldedAt = performance.now(); }
  }
  check();
  checkCapacity(files.length, offset + centralSize + 22);
  const end = new Uint8Array(22), view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true); view.setUint16(8, files.length, true); view.setUint16(10, files.length, true);
  view.setUint32(12, centralSize, true); view.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
