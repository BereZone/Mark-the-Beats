var Mp3 = require('./vendor/js-mp3/index.js');

// LAME/Xing encoder-delay compensation. MP3 encoders (LAME and LAME-compatible
// encoders like ffmpeg's libmp3lame) pad the front of the compressed stream
// with priming samples to fill the MDCT filterbank, and often pad the tail too
// — typically ~528-1152 samples (~12-26ms at 44.1kHz) each way. A decoder that
// doesn't strip these produces PCM whose sample 0 doesn't actually correspond
// to the real start of the audio, which is exactly the kind of thing that would
// shift every downstream beat position by a small, constant amount. This is
// the standard, well-documented mechanism every gapless-aware MP3 player
// compensates for — not specific to this decoder. The vendored js-mp3 decoder
// does no such compensation, so it's done here instead.
//
// The Xing/Info tag (and its optional LAME extension carrying delay/padding)
// lives in the first MP3 frame. Rather than precisely computing its offset
// from the frame header (MPEG version/channel-mode dependent), this scans for
// the tag bytes directly within the first few KB — simpler and more robust to
// getting header-offset math wrong. Returns null (no trim — current behavior)
// if the tag or a plausible LAME extension isn't found, so files without it
// are unaffected.
function findLameDelayPadding(buffer) {
  var view = new Uint8Array(buffer);
  var searchLimit = Math.min(view.length - 4, 4096);
  for (var i = 0; i < searchLimit; i++) {
    if ((view[i] === 0x58 && view[i + 1] === 0x69 && view[i + 2] === 0x6E && view[i + 3] === 0x67) || // "Xing"
        (view[i] === 0x49 && view[i + 1] === 0x6E && view[i + 2] === 0x66 && view[i + 3] === 0x6F)) { // "Info"
      var parsed = parseXingTag(view, i);
      if (parsed) return parsed;
    }
  }
  return null;
}

function parseXingTag(view, tagOffset) {
  try {
    var pos = tagOffset + 4;
    if (pos + 4 > view.length) return null;
    var flags = (view[pos] << 24) | (view[pos + 1] << 16) | (view[pos + 2] << 8) | view[pos + 3];
    pos += 4;
    if (flags & 0x1) pos += 4;   // frames field
    if (flags & 0x2) pos += 4;   // bytes field
    if (flags & 0x4) pos += 100; // TOC
    if (flags & 0x8) pos += 4;   // quality indicator

    // LAME extension starts with a 9-byte encoder-id string ("LAME3.100",
    // "Lavc60.3.", etc). Require it to look like printable ASCII before
    // trusting the delay/padding bytes that follow — without a real LAME
    // extension present, this position holds arbitrary audio data, and
    // parsing that as delay/padding could trim a wildly wrong sample count.
    if (pos + 9 > view.length) return null;
    var id = '';
    for (var k = 0; k < 9; k++) {
      var c = view[pos + k];
      if (c < 0x20 || c > 0x7E) return null;
      id += String.fromCharCode(c);
    }
    pos += 9;

    // revision+vbr(1) lowpass(1) replaygain_peak(4) radio_rg(2) audiophile_rg(2)
    // encoding_flags(1) abr/min_bitrate(1)
    pos += 1 + 1 + 4 + 2 + 2 + 1 + 1;
    if (pos + 3 > view.length) return null;
    var b0 = view[pos], b1 = view[pos + 1], b2 = view[pos + 2];
    var delay   = (b0 << 4) | (b1 >> 4);
    var padding = ((b1 & 0x0F) << 8) | b2;
    if (delay < 0 || delay > 4095 || padding < 0 || padding > 4095) return null;

    console.log('[BM] MP3 encoder tag "' + id.trim() + '" — delay=' + delay + ' padding=' + padding + ' samples');
    return { delay: delay, padding: padding };
  } catch (e) {
    return null;
  }
}

// Decodes MP3 to the same { samples, sampleRate } shape parseWav produces,
// so loadClipAudio can treat MP3 as a first-class source with no AME transcode.
function parseMp3(buffer) {
  var decoder = Mp3.newDecoder(buffer);
  if (!decoder) throw new Error('Could not parse MP3 (invalid or unsupported file)');

  var pcm = decoder.decode(); // ArrayBuffer — util.concatBuffers unwraps the Uint8Array
  if (!pcm || pcm.byteLength === 0) throw new Error('MP3 file contains no decodable audio frames');

  var numChannels = (decoder.frame && typeof decoder.frame.header.numberOfChannels === 'function')
    ? decoder.frame.header.numberOfChannels() : 2;
  var sampleRate = decoder.sampleRate;
  if (!sampleRate) throw new Error('Could not determine MP3 sample rate');

  // pcm holds interleaved signed 16-bit little-endian samples, one channel's
  // worth per frame if mono, two if stereo — see vendor/js-mp3/src/frame.js.
  var view = new DataView(pcm);
  var bytesPerFrame = numChannels * 2;
  var totalFrames = Math.floor(pcm.byteLength / bytesPerFrame);
  if (totalFrames === 0) throw new Error('MP3 file contains no audio samples');

  var lame = findLameDelayPadding(buffer);
  var startFrame = 0, endFrame = totalFrames;
  if (lame) {
    startFrame = Math.min(lame.delay, totalFrames);
    endFrame = Math.max(startFrame, totalFrames - lame.padding);
  }
  var trimmedFrames = endFrame - startFrame;
  if (trimmedFrames <= 0) throw new Error('MP3 file contains no audio samples after encoder-delay trim');

  var samples = new Float32Array(trimmedFrames);
  for (var i = 0; i < trimmedFrames; i++) {
    var srcFrame = startFrame + i;
    var sum = 0;
    for (var ch = 0; ch < numChannels; ch++) {
      sum += view.getInt16(srcFrame * bytesPerFrame + ch * 2, true) / 32768;
    }
    samples[i] = sum / numChannels;
  }

  return { sampleRate: sampleRate, samples: samples, numChannels: numChannels, bitsPerSample: 16 };
}

module.exports = { parseMp3: parseMp3 };
