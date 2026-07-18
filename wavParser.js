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

module.exports = { parseWav: parseWav };
