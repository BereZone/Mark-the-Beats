function parseWav(buffer) {
  var view = new DataView(buffer);

  var riff = readFourCC(view, 0);
  if (riff !== 'RIFF') throw new Error('Not a valid WAV file (missing RIFF header)');
  var wave = readFourCC(view, 8);
  if (wave !== 'WAVE') throw new Error('Not a valid WAV file (missing WAVE marker)');

  var sampleRate, numChannels, bitsPerSample, audioFormat;
  var dataOffset = -1, dataSize = 0;
  var offset = 12;

  while (offset < buffer.byteLength - 8) {
    var chunkId   = readFourCC(view, offset);
    var chunkSize = view.getUint32(offset + 4, true);

    if (chunkId === 'fmt ') {
      audioFormat   = view.getUint16(offset + 8,  true);
      if (audioFormat !== 1 && audioFormat !== 3)
        throw new Error('Only PCM (format 1) and IEEE float (format 3) WAV files are supported');
      numChannels   = view.getUint16(offset + 10, true);
      sampleRate    = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);
    } else if (chunkId === 'data') {
      dataOffset = offset + 8;
      // AME (and some encoders) write 0 in the chunk size field during streaming and
      // don't always update it on close — fall back to actual file size in that case.
      dataSize   = chunkSize > 0 ? chunkSize : buffer.byteLength - dataOffset;
      break;
    }

    offset += 8 + chunkSize + (chunkSize % 2);
  }

  if (!sampleRate)    throw new Error('Could not parse fmt chunk');
  if (dataOffset < 0) throw new Error('No data chunk found in WAV file');

  var bytesPerSample = bitsPerSample / 8;
  var totalFrames    = Math.floor(dataSize / (bytesPerSample * numChannels));
  if (totalFrames === 0) throw new Error('WAV file contains no audio samples');

  var samples = new Float32Array(totalFrames);
  for (var i = 0; i < totalFrames; i++) {
    var sum = 0;
    for (var ch = 0; ch < numChannels; ch++) {
      var pos = dataOffset + (i * numChannels + ch) * bytesPerSample;
      sum += readSample(view, pos, bitsPerSample, audioFormat);
    }
    samples[i] = sum / numChannels;
  }

  return { sampleRate: sampleRate, samples: samples, numChannels: numChannels, bitsPerSample: bitsPerSample };
}

function readFourCC(view, offset) {
  return String.fromCharCode(
    view.getUint8(offset), view.getUint8(offset + 1),
    view.getUint8(offset + 2), view.getUint8(offset + 3)
  );
}

function readSample(view, pos, bits, audioFormat) {
  if (audioFormat === 3) {
    if (bits === 32) return view.getFloat32(pos, true);
    if (bits === 64) return view.getFloat64(pos, true);
  }
  switch (bits) {
    case 8:  return (view.getUint8(pos) - 128) / 128;
    case 16: return view.getInt16(pos, true) / 32768;
    case 24: {
      var lo = view.getUint8(pos), mi = view.getUint8(pos + 1), hi = view.getInt8(pos + 2);
      return ((hi << 16) | (mi << 8) | lo) / 8388608;
    }
    case 32: return view.getInt32(pos, true) / 2147483648;
    default: throw new Error('Unsupported bit depth: ' + bits);
  }
}

// Mono 16-bit PCM WAV from normalized float samples. Playback in the panel goes
// through a media element, which needs a real file rather than the in-memory PCM,
// so the decoded samples are written back out in the one format every decoder
// handles. 16-bit is deliberate: it halves the temp file against 32-bit float for
// no audible loss on a preview, and float WAV support is the less universal path.
function encodeWav(samples, sampleRate) {
  var frames   = samples.length;
  var dataSize = frames * 2;
  var buffer   = new ArrayBuffer(44 + dataSize);
  var view     = new DataView(buffer);

  writeFourCC(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeFourCC(view, 8, 'WAVE');

  writeFourCC(view, 12, 'fmt ');
  view.setUint32(16, 16, true);                 // fmt chunk size
  view.setUint16(20, 1, true);                  // PCM
  view.setUint16(22, 1, true);                  // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);     // byte rate
  view.setUint16(32, 2, true);                  // block align
  view.setUint16(34, 16, true);                 // bits per sample

  writeFourCC(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  for (var i = 0; i < frames; i++) {
    var s = samples[i];
    if (s > 1) s = 1; else if (s < -1) s = -1;
    // Scale by 32768 to pair exactly with readSample's /32768, so the round trip
    // costs only the rounding step. setInt16 truncates a fractional value toward
    // zero, which would double the error, hence the explicit round. +1.0 is the
    // one value int16 can't hold and is clamped to the positive maximum.
    var v = Math.round(s * 0x8000);
    if (v > 0x7FFF) v = 0x7FFF;
    view.setInt16(44 + i * 2, v, true);
  }
  return buffer;
}

function writeFourCC(view, offset, str) {
  for (var i = 0; i < 4; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

module.exports = { parseWav: parseWav, encodeWav: encodeWav };
