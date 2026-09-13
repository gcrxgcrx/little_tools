'use strict';

/**
 * 视频文件的 HTTP 服务：手写 Range 处理，并支持在传输过程中做字节级修正。
 *
 * 为什么不用 express 的 sendFile：
 *   我们需要一个"钩子"——在把字节送出去之前，把 HEVC 的 sample entry 标记
 *   从 hev1 改成 hvc1（Apple 平台只认 hvc1，否则 iPhone 直接播不出来）。
 *   这样原始文件不需要任何改动，硬盘上永远是原样。
 *
 * 因为只改 4 个字节、不改长度，Range / Content-Range / Content-Length 全部不受影响。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Transform } = require('node:stream');

const MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.ts': 'video/mp2t',
  '.avi': 'video/x-msvideo',
};

function etagFor(stat) {
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

/**
 * 解析单段 Range。多段 Range 不支持（Safari/Chrome 播放视频时都用单段）。
 * @returns {null | {start:number,end:number} | {unsatisfiable:true}}
 */
function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) return null;

  const [, startStr, endStr] = match;
  if (startStr === '' && endStr === '') return null;

  let start;
  let end;

  if (startStr === '') {
    const suffix = Number(endStr);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startStr);
    end = endStr === '' ? size - 1 : Number(endStr);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return { unsatisfiable: true };
  return { start, end: Math.min(end, size - 1) };
}

/** 在流式传输中把指定绝对偏移处的 4 个字节替换掉。 */
class BytePatcher extends Transform {
  constructor(startOffset, patchOffset, replacement) {
    super();
    this.pos = startOffset;
    this.patchOffset = patchOffset;
    this.replacement = replacement;
  }

  _transform(chunk, _encoding, callback) {
    const chunkStart = this.pos;
    const chunkEnd = chunkStart + chunk.length;
    const patchEnd = this.patchOffset + this.replacement.length;

    if (this.patchOffset >= chunkStart && patchEnd <= chunkEnd) {
      this.replacement.copy(chunk, this.patchOffset - chunkStart);
    }
    this.pos = chunkEnd;
    callback(null, chunk);
  }
}

/**
 * 提供视频文件。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{path:string}} item
 * @param {{patch?: {offset:number, replacement:Buffer}|null}} [options]
 */
async function serveVideo(req, res, item, options = {}) {
  let stat;
  try {
    stat = await fsp.stat(item.path);
  } catch {
    res.status(404).json({ error: 'not-found' });
    return;
  }
  if (!stat.isFile()) {
    res.status(404).json({ error: 'not-found' });
    return;
  }

  const size = stat.size;
  const etag = etagFor(stat);
  const contentType = MIME[path.extname(item.path).toLowerCase()] || 'application/octet-stream';

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', stat.mtime.toUTCString());
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Content-Type', contentType);

  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }

  const range = parseRange(req.headers.range, size);

  if (range && range.unsatisfiable) {
    res.status(416);
    res.setHeader('Content-Range', `bytes */${size}`);
    res.end();
    return;
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  const length = end - start + 1;

  if (range) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  } else {
    res.status(200);
  }
  res.setHeader('Content-Length', String(length));

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = fs.createReadStream(item.path, { start, end });
  stream.on('error', () => {
    try {
      res.destroy();
    } catch {
      /* 忽略 */
    }
  });

  const patch = options.patch;
  const patchInside = patch && patch.offset >= start && patch.offset + patch.replacement.length <= end + 1;

  if (patchInside) {
    stream.pipe(new BytePatcher(start, patch.offset, patch.replacement)).pipe(res);
  } else {
    stream.pipe(res);
  }
}

module.exports = { serveVideo, parseRange, etagFor, MIME };
