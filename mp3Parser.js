var Mp3 = require('./vendor/js-mp3/index.js');

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

  var samples = new Float32Array(totalFrames);
  for (var i = 0; i < totalFrames; i++) {
    var sum = 0;
    for (var ch = 0; ch < numChannels; ch++) {
      sum += view.getInt16(i * bytesPerFrame + ch * 2, true) / 32768;
    }
    samples[i] = sum / numChannels;
  }

  return { sampleRate: sampleRate, samples: samples, numChannels: numChannels, bitsPerSample: 16 };
}

module.exports = { parseMp3: parseMp3 };
