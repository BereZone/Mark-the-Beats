function detectBeats(samples, sampleRate) {
  if (samples.length < sampleRate * 0.5)
    throw new Error('Audio is too short (< 0.5 s) to detect beats');

  var WIN        = Math.round(sampleRate * 0.02);
  var HOP        = Math.max(1, Math.round(WIN / 2));
  var frameCount = Math.floor((samples.length - WIN) / HOP);
  if (frameCount < 10) throw new Error('Audio too short for beat analysis');

  var energy = new Float64Array(frameCount);
  for (var i = 0; i < frameCount; i++) {
    var sum = 0, base = i * HOP;
    for (var j = 0; j < WIN; j++) { var s = samples[base + j]; sum += s * s; }
    energy[i] = sum / WIN;
  }

  var flux = new Float64Array(frameCount);
  for (var i = 1; i < frameCount; i++)
    flux[i] = Math.max(0, energy[i] - energy[i - 1]);

  var maxFlux = 0;
  for (var i = 0; i < flux.length; i++) if (flux[i] > maxFlux) maxFlux = flux[i];
  if (maxFlux < 1e-10) throw new Error('Audio appears to be silent — no beats detected');

  var mean = 0;
  for (var i = 0; i < flux.length; i++) mean += flux[i];
  mean /= flux.length;

  var variance = 0;
  for (var i = 0; i < flux.length; i++) variance += (flux[i] - mean) * (flux[i] - mean);
  variance /= flux.length;

  var threshold = mean + 1.5 * Math.sqrt(variance);
  var onsets = [];

  for (var i = 1; i < flux.length - 1; i++) {
    if (flux[i] > threshold && flux[i] > flux[i - 1] && flux[i] >= flux[i + 1]) {
      var tSec = (i * HOP) / sampleRate;
      if (onsets.length === 0 || (tSec - onsets[onsets.length - 1]) >= 0.1)
        onsets.push(tSec);
    }
  }

  if (onsets.length < 2)
    throw new Error('Too few onsets detected — audio may be ambient or non-rhythmic');

  var iois = [];
  for (var i = 1; i < onsets.length; i++) iois.push(onsets[i] - onsets[i - 1]);

  var bestBpm = 120, bestScore = -Infinity;
  var mults = [0.25, 0.5, 1, 2, 3, 4];
  for (var bpm = 60; bpm <= 200; bpm += 0.5) {
    var period = 60 / bpm, score = 0;
    for (var ii = 0; ii < iois.length; ii++) {
      for (var m = 0; m < mults.length; m++) {
        var expected = period * mults[m];
        var diff = Math.abs(iois[ii] - expected);
        if (diff < expected * 0.12) score += 1 / (diff / expected + 0.01);
      }
    }
    if (score > bestScore) { bestScore = score; bestBpm = bpm; }
  }

  var gridPeriod = 60 / bestBpm;
  var bestPhase = onsets[0], bestPhaseScore = -Infinity;
  var searchLen = Math.min(16, onsets.length);
  for (var oi = 0; oi < searchLen; oi++) {
    var candidate = onsets[oi], phaseScore = 0;
    for (var ki = 0; ki < onsets.length; ki++) {
      var d = ((onsets[ki] - candidate) % gridPeriod + gridPeriod) % gridPeriod;
      phaseScore -= Math.min(d, gridPeriod - d);
    }
    if (phaseScore > bestPhaseScore) { bestPhaseScore = phaseScore; bestPhase = candidate; }
  }

  bestPhase = ((bestPhase % gridPeriod) + gridPeriod) % gridPeriod;

  var duration = samples.length / sampleRate;
  var beats = [];
  for (var t = bestPhase; t < duration; t += gridPeriod) beats.push(t);

  return { bpm: bestBpm, beats: beats };
}

module.exports = { detectBeats: detectBeats };
