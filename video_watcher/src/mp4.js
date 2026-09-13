'use strict';

/**
 * 最小 MP4/MOV 箱子解析器。
 *
 * 目的：在不依赖 ffmpeg 的前提下，回答三个决定"她 iPhone 能不能播"的问题：
 *   1. faststart —— moov 是否在 mdat 之前（否则 iOS 拖进度条体验极差）
 *   2. 视频编码 —— avc1(H.264) 最稳；hvc1/hev1(H.265) iOS 可播但安卓兼容性差
 *   3. 音频编码 —— mp4a(AAC) 最稳；ac-3/ec-3/dts 在 iOS 上可能无声
 */

const fsp = require('node:fs/promises');

const HEADER_PROBE_BYTES = 16;
const MAX_BOX_ITERATIONS = 4096;
const MAX_MOOV_BYTES = 64 * 1024 * 1024;

async function readAt(fd, length, position) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fd.read(buf, 0, length, position);
  return bytesRead === length ? buf : buf.subarray(0, bytesRead);
}

async function readBoxHeader(fd, offset, fileSize) {
  const buf = await readAt(fd, HEADER_PROBE_BYTES, offset);
  if (buf.length < 8) return null;

  let size = buf.readUInt32BE(0);
  const type = buf.toString('latin1', 4, 8);
  let headerSize = 8;

  if (size === 1) {
    if (buf.length < 16) return null;
    size = Number(buf.readBigUInt64BE(8));
    headerSize = 16;
  } else if (size === 0) {
    size = fileSize - offset;
  }

  if (!Number.isFinite(size) || size < headerSize) return null;
  return { type, size, headerSize, offset };
}

async function listTopLevelBoxes(fd, fileSize) {
  const boxes = [];
  let offset = 0;
  let guard = 0;

  while (offset < fileSize && guard++ < MAX_BOX_ITERATIONS) {
    const header = await readBoxHeader(fd, offset, fileSize);
    if (!header) break;
    boxes.push(header);
    if (header.size <= 0) break;
    offset += header.size;
  }
  return boxes;
}

function* iterBoxes(buf, start, end) {
  let off = start;
  let guard = 0;

  while (off + 8 <= end && guard++ < MAX_BOX_ITERATIONS) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    let headerSize = 8;

    if (size === 1) {
      if (off + 16 > end) return;
      size = Number(buf.readBigUInt64BE(off + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - off;
    }

    if (!Number.isFinite(size) || size < headerSize || off + size > end) return;
    yield { type, start: off, end: off + size, contentStart: off + headerSize };
    off += size;
  }
}

function findChild(buf, parent, type) {
  if (!parent) return null;
  for (const box of iterBoxes(buf, parent.contentStart, parent.end)) {
    if (box.type === type) return box;
  }
  return null;
}

function findAll(buf, parent, type) {
  const out = [];
  if (!parent) return out;
  for (const box of iterBoxes(buf, parent.contentStart, parent.end)) {
    if (box.type === type) out.push(box);
  }
  return out;
}

function readMvhd(buf, mvhd) {
  if (!mvhd) return null;
  const version = buf.readUInt8(mvhd.contentStart);
  if (version === 1) {
    const timescale = buf.readUInt32BE(mvhd.contentStart + 20);
    const duration = Number(buf.readBigUInt64BE(mvhd.contentStart + 24));
    return { timescale, duration };
  }
  const timescale = buf.readUInt32BE(mvhd.contentStart + 12);
  const duration = buf.readUInt32BE(mvhd.contentStart + 16);
  return { timescale, duration };
}

function readHandlerType(buf, mdia) {
  const hdlr = findChild(buf, mdia, 'hdlr');
  if (!hdlr || hdlr.contentStart + 12 > hdlr.end) return null;
  return buf.toString('latin1', hdlr.contentStart + 8, hdlr.contentStart + 12);
}

function readSampleEntryCodec(buf, mdia) {
  const minf = findChild(buf, mdia, 'minf');
  const stbl = findChild(buf, minf, 'stbl');
  const stsd = findChild(buf, stbl, 'stsd');
  if (!stsd) return null;

  // stsd: version(1) flags(3) entry_count(4) 之后是第一个 sample entry 的 size(4)+type(4)
  const firstEntry = stsd.contentStart + 8;
  if (firstEntry + 8 > stsd.end) return null;
  return buf.toString('latin1', firstEntry + 4, firstEntry + 8);
}

/**
 * @param {string} filePath
 * @returns {Promise<null | {
 *   durationSec: number|null, videoCodec: string|null, audioCodec: string|null,
 *   faststart: boolean|null, moovOffset: number|null, mdatOffset: number|null
 * }>}
 */
async function probeMp4(filePath) {
  let fd;
  try {
    fd = await fsp.open(filePath, 'r');
    const { size } = await fd.stat();
    if (size < 32) return null;

    const top = await listTopLevelBoxes(fd, size);
    const moovBox = top.find((b) => b.type === 'moov');
    const mdatBox = top.find((b) => b.type === 'mdat');

    if (!moovBox) {
      return {
        durationSec: null,
        videoCodec: null,
        audioCodec: null,
        faststart: null,
        moovOffset: null,
        mdatOffset: mdatBox ? mdatBox.offset : null,
      };
    }

    const moovLength = Math.min(moovBox.size, MAX_MOOV_BYTES);
    const moovBuf = await readAt(fd, moovLength, moovBox.offset);
    const moov = { contentStart: moovBox.headerSize, end: moovBuf.length };

    const mvhd = readMvhd(moovBuf, findChild(moovBuf, moov, 'mvhd'));
    let durationSec = null;
    if (mvhd && mvhd.timescale > 0 && mvhd.duration > 0) {
      durationSec = mvhd.duration / mvhd.timescale;
    }

    let videoCodec = null;
    let audioCodec = null;
    for (const trak of findAll(moovBuf, moov, 'trak')) {
      const mdia = findChild(moovBuf, trak, 'mdia');
      if (!mdia) continue;
      const handler = readHandlerType(moovBuf, mdia);
      const codec = readSampleEntryCodec(moovBuf, mdia);
      if (handler === 'vide' && !videoCodec) videoCodec = codec;
      if (handler === 'soun' && !audioCodec) audioCodec = codec;
    }

    return {
      durationSec,
      videoCodec,
      audioCodec,
      faststart: mdatBox ? moovBox.offset < mdatBox.offset : null,
      moovOffset: moovBox.offset,
      mdatOffset: mdatBox ? mdatBox.offset : null,
    };
  } catch {
    return null;
  } finally {
    if (fd) await fd.close().catch(() => {});
  }
}

/**
 * 把探测结果翻译成"她 iPhone 能不能直接播"的结论。
 * @returns {{ level: 'ok'|'warn'|'bad', notes: string[] }}
 */
function assessForIos(probe) {
  const notes = [];
  let level = 'ok';

  if (!probe) {
    return { level: 'warn', notes: ['无法解析容器结构'] };
  }

  if (probe.faststart === false) {
    // 本项目的服务端支持 HTTP Range，所以非 faststart 仍可正常播放，
    // 只是浏览器要先取一次文件尾部拿到 moov，首帧和拖动会略慢。
    if (level === 'ok') level = 'warn';
    notes.push(
      'moov 在文件尾部（非 faststart）：浏览器需先请求文件尾再开始播放，首帧与拖动略慢。' +
        '有 Range 支持所以能正常播；想更顺可用 ffmpeg 重封装（可选）'
    );
  }

  const v = (probe.videoCodec || '').toLowerCase();
  if (!v) {
    notes.push('未识别到视频轨');
    if (level === 'ok') level = 'warn';
  } else if (v === 'avc1' || v === 'avc3') {
    notes.push('视频 H.264，iOS/安卓通吃');
  } else if (v === 'hvc1') {
    notes.push('视频 H.265/HEVC（hvc1 封装），iPhone 可播，但部分老旧安卓机型不行');
    if (level === 'ok') level = 'warn';
  } else if (v === 'hev1') {
    level = 'bad';
    notes.push(
      '视频 H.265/HEVC 以 hev1 封装，Apple 平台（Safari/QuickTime）通常无法播放 —— ' +
        '可用 `node src/fix-hevc-cli.js --apply` 无损修补（只改 4 字节 fourcc，不重新编码）'
    );
  } else if (v === 'vp09' || v === 'av01') {
    notes.push(`视频编码 ${v}，iOS Safari 支持有限`);
    if (level === 'ok') level = 'warn';
  } else {
    notes.push(`视频编码 ${v}，iOS 支持存疑`);
    if (level === 'ok') level = 'warn';
  }

  const a = (probe.audioCodec || '').toLowerCase();
  if (!a) {
    notes.push('未识别到音频轨');
  } else if (a === 'mp4a') {
    notes.push('音频 AAC，iOS 正常');
  } else if (a === 'ac-3' || a === 'ec-3' || a === 'dtsc' || a === 'dtsh' || a === 'dtse') {
    level = 'bad';
    notes.push(`音频 ${a}，iOS Safari 大概率无声 —— 需要只转音频轨`);
  } else {
    notes.push(`音频编码 ${a}，iOS 支持存疑`);
    if (level === 'ok') level = 'warn';
  }

  return { level, notes };
}

/**
 * 定位视频轨的 sample entry，读取 fourcc 与 hvcC 参数集信息。
 *
 * 用途：判断 `hev1` → `hvc1` 的 4 字节无损修补是否安全。
 * 在 MP4 中两种封装都必须在 hvcC 里带参数集（VPS/SPS/PPS），
 * 若 hvcC 里没有，就不能只改标记，必须用 ffmpeg 重新封装。
 *
 * @param {string} filePath
 * @returns {Promise<null | {
 *   fourcc: string, fourccOffset: number,
 *   hvcC: { found: boolean, numArrays: number, nalTypes: number[] } | null
 * }>}
 */
async function analyzeVideoSampleEntry(filePath) {
  let fd;
  try {
    fd = await fsp.open(filePath, 'r');
    const { size } = await fd.stat();
    if (size < 32) return null;

    const top = await listTopLevelBoxes(fd, size);
    const moovBox = top.find((b) => b.type === 'moov');
    if (!moovBox) return null;

    const moovLength = Math.min(moovBox.size, MAX_MOOV_BYTES);
    const moovBuf = await readAt(fd, moovLength, moovBox.offset);
    const moov = { contentStart: moovBox.headerSize, end: moovBuf.length };

    for (const trak of findAll(moovBuf, moov, 'trak')) {
      const mdia = findChild(moovBuf, trak, 'mdia');
      if (!mdia) continue;
      if (readHandlerType(moovBuf, mdia) !== 'vide') continue;

      const minf = findChild(moovBuf, mdia, 'minf');
      const stbl = findChild(moovBuf, minf, 'stbl');
      const stsd = findChild(moovBuf, stbl, 'stsd');
      if (!stsd) continue;

      const entryStart = stsd.contentStart + 8;
      if (entryStart + 86 > stsd.end) continue;

      const entrySize = moovBuf.readUInt32BE(entryStart);
      const fourcc = moovBuf.toString('latin1', entryStart + 4, entryStart + 8);
      const entryEnd = Math.min(entryStart + entrySize, stsd.end);

      // VisualSampleEntry 固定 78 字节，其中已含 size(4)+type(4)
      const childStart = entryStart + 86;

      let hvcC = null;
      for (const child of iterBoxes(moovBuf, childStart, entryEnd)) {
        if (child.type !== 'hvcC') continue;
        const numArrays = moovBuf.readUInt8(child.contentStart + 22);
        const nalTypes = [];
        let cursor = child.contentStart + 23;
        for (let i = 0; i < numArrays && cursor + 3 <= child.end; i += 1) {
          const nalType = moovBuf.readUInt8(cursor) & 0x3f;
          const numNalus = moovBuf.readUInt16BE(cursor + 1);
          nalTypes.push(nalType);
          cursor += 3;
          for (let j = 0; j < numNalus && cursor + 2 <= child.end; j += 1) {
            const nalLength = moovBuf.readUInt16BE(cursor);
            cursor += 2 + nalLength;
          }
        }
        hvcC = { found: true, numArrays, nalTypes };
        break;
      }

      return {
        fourcc,
        fourccOffset: moovBox.offset + entryStart + 4,
        hvcC,
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd) await fd.close().catch(() => {});
  }
}

/** 把 sample entry 的 fourcc 就地改成 hvc1（4 字节，不改尺寸、不重新编码）。 */
async function retagFourcc(filePath, offset, newFourcc) {
  const fd = await fsp.open(filePath, 'r+');
  try {
    await fd.write(Buffer.from(newFourcc, 'latin1'), 0, 4, offset);
  } finally {
    await fd.close().catch(() => {});
  }
}

module.exports = { probeMp4, assessForIos, analyzeVideoSampleEntry, retagFourcc };
