var parseWav    = require('./wavParser.js').parseWav;
var parseMp3    = require('./mp3Parser.js').parseMp3;
var detectBeats = require('./beatDetector.js').detectBeats;
var ppro        = require('premierepro');
var uxp         = require('uxp');
var localFs     = uxp.storage.localFileSystem;
var formats     = uxp.storage.formats;

var TICKS_PER_SECOND = 254016000000;

// Cached result of the last Analyze run: { clipInfo, sourceStart, duration, bpm,
// allBeats, detected, waveform }. Place Markers commits against this, not a fresh
// selection query, so markers always land on the clip that was actually previewed.
var analysis = null;

var PREVIEW_COLORS = {
  '-1': '#4a9ef7', // Default -> accent blue
  '0':  '#5cb85c', // Green
  '1':  '#d9534f', // Red
  '2':  '#9b59b6', // Purple
  '3':  '#e67e22', // Orange
  '4':  '#f1c40f', // Yellow
  '5':  '#ffffff', // White
  '6':  '#4a9ef7', // Blue
  '7':  '#17c3c3'  // Cyan
};

// ── Zoom/pan/playback state ─────────────────────────────────────────────────

var DEFAULT_ZOOM_SEC = 4;
var MIN_ZOOM_SEC = 0.5;

// Visible window into analysis.duration, in clip-relative seconds: { start, len }.
// Reset to zoomed-in-at-the-start on every fresh Analyze.
var previewWindow = null;

// True while "Set Beat 1" is armed: the next waveform click sets analysis.anchor
// instead of seeking.
var anchorArmed = false;

// requestAnimationFrame isn't guaranteed in UXP's panel webview (canvas already
// turned out to be missing standard APIs there) — fall back to a plain timer.
var rafFn = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame : function (cb) { return setTimeout(cb, 33); };
var cafFn = (typeof cancelAnimationFrame  === 'function') ? cancelAnimationFrame  : clearTimeout;

function clampNum(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// ── UI wiring ─────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('analyzeBtn').addEventListener('click', function () {
    var btn = document.getElementById('analyzeBtn');
    btn.disabled = true;
    runAnalyze().finally(function () { btn.disabled = false; });
  });
  document.getElementById('placeBtn').addEventListener('click', function () {
    var btn = document.getElementById('placeBtn');
    btn.disabled = true;
    runPlaceMarkers().finally(function () { btn.disabled = false; });
  });
  document.getElementById('autoBpmBtn').addEventListener('click', function () {
    var bpmInput = document.getElementById('manualBpm');
    bpmInput.value = '';
    bpmInput.dispatchEvent(new Event('input', { bubbles: true }));
    bpmInput.dispatchEvent(new Event('change', { bubbles: true }));
  });
  document.getElementById('manualBpm').addEventListener('input', onBpmChanged);
  document.getElementById('nthBeat').addEventListener('change', onFilterChanged);
  document.getElementById('offset').addEventListener('input', onFilterChanged);
  document.getElementById('markerColor').addEventListener('change', onFilterChanged);
  document.getElementById('playBtn').addEventListener('click', togglePlayback);
  document.getElementById('zoomThumb').addEventListener('mousedown', function (evt) { startZoomBarDrag(evt, 'pan'); });
  document.getElementById('zoomHandleLeft').addEventListener('mousedown', function (evt) { startZoomBarDrag(evt, 'left'); });
  document.getElementById('zoomHandleRight').addEventListener('mousedown', function (evt) { startZoomBarDrag(evt, 'right'); });
  document.getElementById('zoomBar').addEventListener('mousedown', function (evt) {
    if (evt.target.id === 'zoomBar') startZoomBarDrag(evt, 'jump');
  });
  document.getElementById('zoomInBtn').addEventListener('click', function () { zoomBy(0.7); });
  document.getElementById('zoomOutBtn').addEventListener('click', function () { zoomBy(1 / 0.7); });
  document.getElementById('previewCanvas').addEventListener('click', onCanvasClick);
  document.getElementById('anchorBtn').addEventListener('click', toggleAnchorArm);
  document.getElementById('anchorClearBtn').addEventListener('click', clearAnchor);
  // Confirmed live: this UXP host never dispatches 'wheel' events into the panel
  // DOM at all (click/mousedown are forwarded, wheel isn't — a gap in the native
  // embedding, not a JS-side binding issue, so no event-registration trick fixes
  // it). Zoom is click/drag-only: the zoom bar's edge handles, or the +/− buttons.
  document.getElementById('clearMarkersBtn').addEventListener('click', function () {
    var btn = document.getElementById('clearMarkersBtn');
    btn.disabled = true;
    runClearMarkers().finally(function () { btn.disabled = false; });
  });
  document.getElementById('clearBtn').addEventListener('click', function () {
    document.getElementById('statusLog').innerHTML = '';
  });
  window.addEventListener('resize', function () {
    if (analysis) redrawPreview();
  });
});

// ── Main flow ─────────────────────────────────────────────────────────────────

// Locates the selected clip, computes the full (unfiltered) beat grid — either
// from auto-detection or the manual BPM field — and caches it in `analysis` for
// live preview redraws and the eventual Place Markers commit. Does not touch
// the timeline.
async function runAnalyze() {
  try {
    var project = await ppro.Project.getActiveProject();
    if (!project) throw new Error('No active project — open a project first');

    var sequence = await project.getActiveSequence();
    if (!sequence) throw new Error('No active sequence — open a sequence in the timeline first');

    log('Locating selected clip…', 'info');
    var clipInfo = await getSelectedClipInfo(sequence);
    if (!clipInfo) throw new Error('No clip selected — click an audio clip in the timeline first');
    log('Clip: ' + clipInfo.start.toFixed(3) + ' s – ' + clipInfo.end.toFixed(3) + ' s', 'info');

    var trackItem = clipInfo.trackItem;
    var sourceStart = 0;
    try {
      var ip = typeof trackItem.getInPoint === 'function' ? await trackItem.getInPoint() : null;
      if (ip && ip.ticks) sourceStart = ticksToSeconds(ip.ticks);
    } catch (_) {}

    var manualBpm = parseFloat(document.getElementById('manualBpm').value);
    var bpm, allBeats, duration, waveform = null, detected = null;

    if (!isNaN(manualBpm)) {
      if (manualBpm < 1 || manualBpm > 999) throw new Error('BPM must be between 1 and 999');
      duration = clipInfo.end - clipInfo.start;
      bpm = manualBpm;
      allBeats = beatsFromBpm(bpm, duration).beats;
      log('Using manual BPM: ' + bpm.toFixed(1), 'info');
    } else {
      var audio = await loadClipAudio(clipInfo);
      log('Audio: ' + audio.sampleRate + ' Hz, ' + (audio.samples.length / audio.sampleRate).toFixed(1) + ' s', 'info');

      log('Detecting beats…', 'info');
      var result = detectBeats(audio.samples, audio.sampleRate);
      bpm = result.bpm;
      allBeats = result.beats;
      duration = audio.samples.length / audio.sampleRate;
      waveform = audio;
      detected = { bpm: bpm, beats: allBeats };
      log('Detected ' + bpm.toFixed(1) + ' BPM', 'info');
    }

    // sequence/project are cached alongside the clip so Place Markers and
    // playback both operate on what was actually analyzed, not whatever
    // happens to be active/selected later.
    // naturalBeats is the un-anchored grid (detector phase, or a from-in-point
    // BPM grid); allBeats is what preview/placement consume and is derived from
    // it by applyGrid, re-phased through the downbeat anchor when one is set.
    analysis = {
      clipInfo: clipInfo, sequence: sequence, project: project,
      sourceStart: sourceStart, duration: duration,
      bpm: bpm, naturalBeats: allBeats, allBeats: allBeats,
      anchor: null, detected: detected, waveform: waveform
    };
    anchorArmed = false;
    applyGrid();

    previewWindow = { start: 0, len: Math.min(DEFAULT_ZOOM_SEC, duration) };
    previewPlayheadRel = null;

    document.getElementById('placeBtn').disabled = false;
    updateAnchorUi();
    document.getElementById('zoomBar').classList.remove('disabled');
    document.getElementById('zoomInBtn').disabled = false;
    document.getElementById('zoomOutBtn').disabled = false;
    document.getElementById('playBtn').disabled = false;
    document.getElementById('playBtn').textContent = '▶ Play';
    updateZoomBar();
    redrawPreview();
    log('Analysis ready — adjust settings or click Place Markers.', 'success');

  } catch (err) {
    analysis = null;
    previewWindow = null;
    resetPreviewControls();
    showPreviewMessage('No analysis yet — click Analyze.');
    log('Error: ' + err.message, 'error');
    console.error('[BM]', err);
  }
}

function resetPreviewControls() {
  document.getElementById('placeBtn').disabled = true;
  document.getElementById('zoomBar').classList.add('disabled');
  document.getElementById('zoomInBtn').disabled = true;
  document.getElementById('zoomOutBtn').disabled = true;
  stopPlayheadPoll();
  previewPlayheadRel = null;
  var playBtn = document.getElementById('playBtn');
  playBtn.disabled = true;
  playBtn.textContent = '▶ Play';
  anchorArmed = false;
  updateAnchorUi();
}

// Commits the cached analysis to clip markers on the clip that was analyzed —
// not whatever happens to be selected now, so the preview stays trustworthy.
async function runPlaceMarkers() {
  if (!analysis) { log('Nothing to place — click Analyze first.', 'error'); return; }
  try {
    var project = await ppro.Project.getActiveProject();
    if (!project) throw new Error('No active project — open a project first');

    var sequence = await project.getActiveSequence();
    if (!sequence) throw new Error('No active sequence — open a sequence in the timeline first');

    var nthBeat    = parseInt(document.getElementById('nthBeat').value, 10) || 1;
    var offsetSec  = (parseFloat(document.getElementById('offset').value) || 0) / 1000;
    var prefix     = document.getElementById('prefix').value.trim() || 'Beat';
    var colorIndex = parseInt(document.getElementById('markerColor').value, 10);

    var trackItem   = analysis.clipInfo.trackItem;
    var sourceStart = analysis.sourceStart;

    log('Placing markers…', 'info');

    var pi = await trackItem.getProjectItem();
    var clipItem2 = ppro.ClipProjectItem.queryCast(pi) || pi;
    var markersCollection = await ppro.Markers.getMarkers(clipItem2);
    var beforeCount = await countMarkers(markersCollection);
    var count = 0;

    for (var i = 0; i < analysis.allBeats.length; i++) {
      if (i % nthBeat !== 0) continue;
      var sourceTimeSec = sourceStart + analysis.allBeats[i] + offsetSec;
      if (sourceTimeSec < 0) continue;
      var marker = await createClipMarker(project, sequence, markersCollection, sourceTimeSec, prefix + ' ' + (count + 1));
      count++;
      if (colorIndex >= 0 && marker) await setMarkerColor(project, marker, colorIndex);
    }

    var afterCount = await countMarkers(markersCollection);
    if (beforeCount >= 0 && afterCount >= 0) {
      log('Markers on clip: ' + beforeCount + ' → ' + afterCount, 'info');
    }
    log('Done — placed ' + count + ' markers at ' + analysis.bpm.toFixed(1) + ' BPM.', 'success');

  } catch (err) {
    log('Error: ' + err.message, 'error');
    console.error('[BM]', err);
  }
}

// Recomputes the BPM grid when the BPM field changes, without re-decoding or
// re-detecting. A valid manual value regrids instantly from the cached duration;
// clearing back to Auto restores the cached auto-detected grid if this analysis
// ever ran detection, otherwise there's nothing to fall back to and Analyze
// must run again (detection requires decoded audio we don't keep around unless
// it was already decoded for this same analysis).
function onBpmChanged() {
  if (!analysis) return;
  var raw = document.getElementById('manualBpm').value;
  var val = parseFloat(raw);
  if (!isNaN(val)) {
    if (val < 1 || val > 999) return;
    analysis.bpm = val;
    analysis.naturalBeats = beatsFromBpm(val, analysis.duration).beats;
    applyGrid();
    document.getElementById('placeBtn').disabled = false;
    redrawPreview();
  } else if (raw === '') {
    if (analysis.detected) {
      analysis.bpm = analysis.detected.bpm;
      analysis.naturalBeats = analysis.detected.beats;
      applyGrid();
      document.getElementById('placeBtn').disabled = false;
      redrawPreview();
      log('Reverted to detected BPM: ' + analysis.bpm.toFixed(1), 'info');
    } else {
      document.getElementById('placeBtn').disabled = true;
      showPreviewMessage('BPM cleared — click Analyze to auto-detect.');
    }
  }
}

// Interval, offset, and color changes never affect the underlying beat grid or
// require re-analysis — just re-filter and redraw.
function onFilterChanged() {
  if (!analysis) return;
  redrawPreview();
}

function redrawPreview() {
  if (!analysis || !previewWindow) return;
  var nthBeat    = parseInt(document.getElementById('nthBeat').value, 10) || 1;
  var offsetSec  = (parseFloat(document.getElementById('offset').value) || 0) / 1000;
  var colorIndex = parseInt(document.getElementById('markerColor').value, 10);

  var previewBeats = [];
  for (var i = 0; i < analysis.allBeats.length; i++) {
    if (i % nthBeat !== 0) continue;
    var t = analysis.allBeats[i] + offsetSec;
    if (t < 0 || t > analysis.duration) continue;
    previewBeats.push(t);
  }

  drawWaveformPreview(analysis.waveform, analysis.duration, previewBeats, colorIndex, previewWindow, previewPlayheadRel, analysis.anchor);

  var info = document.getElementById('previewInfo');
  if (info) {
    info.textContent = analysis.bpm.toFixed(1) + ' BPM — ' + previewBeats.length + ' markers — showing ' +
      previewWindow.start.toFixed(1) + 's–' + (previewWindow.start + previewWindow.len).toFixed(1) +
      's of ' + analysis.duration.toFixed(1) + 's';
  }
}

function drawWaveformPreview(waveform, durationSec, beatsSec, colorIndex, win, playheadRel, anchorRel) {
  var canvas = document.getElementById('previewCanvas');
  if (!canvas || !durationSec || !win) return;

  var cssWidth  = canvas.clientWidth  || 280;
  var cssHeight = canvas.clientHeight || 64;
  var ctx = canvas.getContext('2d');

  // Setting canvas.width/height resets the backing store and its transform to
  // identity, so a fresh scale() per redraw is correct rather than compounding.
  // UXP's canvas implementation doesn't support setTransform (only scale), and
  // may lack scale too on some builds — fall back to a 1x (CSS-pixel) backing
  // store rather than leaving a mismatched half-scaled canvas.
  var dpr = window.devicePixelRatio || 1;
  var scaled = false;
  if (dpr !== 1 && typeof ctx.scale === 'function') {
    try {
      canvas.width  = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssHeight * dpr);
      ctx.scale(dpr, dpr);
      scaled = true;
    } catch (_) { scaled = false; }
  }
  if (!scaled) {
    canvas.width  = cssWidth;
    canvas.height = cssHeight;
  }

  ctx.fillStyle = '#202020';
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  var midY = cssHeight / 2;
  var winStart = win.start, winLen = Math.max(0.001, win.len), winEnd = winStart + winLen;

  // Drawn as one filled rect per column/tick rather than a single multi-subpath
  // stroke — UXP's canvas doesn't reliably keep moveTo-separated subpaths disjoint,
  // so a path with hundreds of independent 2-point segments rendered as one solid
  // fill instead of a waveform. fillRect per column has no path/subpath ambiguity.
  if (waveform && waveform.samples && waveform.samples.length > 0) {
    var samples = waveform.samples;
    var sr = waveform.sampleRate;
    var startSample = clampNum(Math.floor(winStart * sr), 0, samples.length);
    var endSample   = clampNum(Math.ceil(winEnd * sr), startSample, samples.length);
    var visibleSamples = Math.max(1, endSample - startSample);
    var samplesPerPixel = visibleSamples / cssWidth;
    ctx.fillStyle = '#5a7ea8';
    for (var x = 0; x < cssWidth; x++) {
      var startIdx = startSample + Math.floor(x * samplesPerPixel);
      var endIdx   = Math.min(samples.length, startSample + Math.floor((x + 1) * samplesPerPixel) + 1);
      var min = 1, max = -1;
      for (var i = startIdx; i < endIdx; i++) {
        var v = samples[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (startIdx >= endIdx) { min = 0; max = 0; }
      var yTop = midY - max * midY * 0.9;
      var yBot = midY - min * midY * 0.9;
      ctx.fillRect(x, yTop, 1, Math.max(1, yBot - yTop));
    }
  } else {
    ctx.fillStyle = '#4a4a4a';
    ctx.fillRect(0, midY, cssWidth, 1);
  }

  var tickColor = PREVIEW_COLORS[String(colorIndex)] || '#4a9ef7';
  ctx.fillStyle = tickColor;
  for (var b = 0; b < beatsSec.length; b++) {
    var t = beatsSec[b];
    if (t < winStart || t > winEnd) continue;
    var xPos = Math.round(((t - winStart) / winLen) * cssWidth);
    ctx.fillRect(xPos, 0, 1, cssHeight);
  }

  // Downbeat anchor: a distinct gold line with a small flag block at the top, so
  // the locked Beat 1 reads apart from the beat ticks and the white playhead.
  // Drawn as fillRects (no path/triangle) — UXP's canvas path handling is
  // unreliable here, as the waveform rendering above already works around.
  if (anchorRel != null && anchorRel >= winStart && anchorRel <= winEnd) {
    var ax = Math.round(((anchorRel - winStart) / winLen) * cssWidth);
    ctx.fillStyle = '#ffd24a';
    ctx.fillRect(ax, 0, 2, cssHeight);
    ctx.fillRect(ax - 3, 0, 8, 5);
  }

  if (playheadRel != null && playheadRel >= winStart && playheadRel <= winEnd) {
    ctx.fillStyle = '#ffffff';
    var px = Math.round(((playheadRel - winStart) / winLen) * cssWidth);
    ctx.fillRect(px, 0, 2, cssHeight);
  }
}

function showPreviewMessage(msg) {
  var info = document.getElementById('previewInfo');
  if (info) info.textContent = msg;
  var canvas = document.getElementById('previewCanvas');
  if (!canvas) return;
  var cssWidth  = canvas.clientWidth  || 280;
  var cssHeight = canvas.clientHeight || 64;
  canvas.width  = cssWidth;
  canvas.height = cssHeight;
  var ctx = canvas.getContext('2d');
  ctx.fillStyle = '#202020';
  ctx.fillRect(0, 0, cssWidth, cssHeight);
}

// ── Zoom / pan (Premiere-style zoom bar) ────────────────────────────────────────

// Reflects previewWindow onto the zoom bar's thumb position/width as percentages
// of the full clip duration.
function updateZoomBar() {
  var thumb = document.getElementById('zoomThumb');
  if (!thumb || !analysis || !previewWindow || !analysis.duration) return;
  var leftPct  = (previewWindow.start / analysis.duration) * 100;
  var widthPct = (previewWindow.len   / analysis.duration) * 100;
  thumb.style.left  = clampNum(leftPct, 0, 100) + '%';
  thumb.style.width = clampNum(widthPct, (MIN_ZOOM_SEC / analysis.duration) * 100, 100) + '%';
}

// Redraw is coalesced to once per animation frame during a drag — recomputing
// the whole waveform (min/max scan over every visible sample, per pixel column)
// on every single mousemove was the source of the jittery/glitchy dragging:
// mousemove can fire far more often than the canvas needs to actually repaint.
// The zoom bar's own thumb position (cheap CSS, via updateZoomBar) still updates
// on every move for immediate visual feedback; only the expensive canvas redraw
// is throttled.
var _dragRedrawPending = false;
function scheduleDragRedraw() {
  if (_dragRedrawPending) return;
  _dragRedrawPending = true;
  rafFn(function () { _dragRedrawPending = false; redrawPreview(); });
}

// mode: 'pan' (drag thumb body), 'left'/'right' (resize from that edge), or
// 'jump' (mousedown on the bare track — recenters the window there).
function startZoomBarDrag(evt, mode) {
  if (!analysis || !previewWindow) return;
  evt.preventDefault();
  // Without this, a mousedown on a handle also bubbles to the parent thumb's
  // own 'pan' listener, starting a second, conflicting drag session at the same
  // time — both mousemove handlers then fight over previewWindow every tick,
  // which is what made dragging near an edge feel glitchy/unresponsive.
  if (typeof evt.stopPropagation === 'function') evt.stopPropagation();

  var bar = document.getElementById('zoomBar');
  var rect = bar.getBoundingClientRect();
  if (!rect || !rect.width) return;
  var duration = analysis.duration;
  var startWin = { start: previewWindow.start, len: previewWindow.len };
  var startX = evt.clientX;

  function xToSec(clientX) {
    return clampNum((clientX - rect.left) / rect.width, 0, 1) * duration;
  }

  if (mode === 'jump') {
    var center = xToSec(startX);
    previewWindow.start = clampNum(center - previewWindow.len / 2, 0, Math.max(0, duration - previewWindow.len));
    updateZoomBar();
    redrawPreview();
    return;
  }

  function onMove(mv) {
    var dxSec = ((mv.clientX - startX) / rect.width) * duration;
    if (mode === 'pan') {
      previewWindow.start = clampNum(startWin.start + dxSec, 0, Math.max(0, duration - startWin.len));
    } else if (mode === 'left') {
      var rightEdge = startWin.start + startWin.len;
      var newStart = clampNum(startWin.start + dxSec, 0, rightEdge - MIN_ZOOM_SEC);
      previewWindow.start = newStart;
      previewWindow.len = rightEdge - newStart;
    } else if (mode === 'right') {
      var newLen = clampNum(startWin.len + dxSec, MIN_ZOOM_SEC, duration - startWin.start);
      previewWindow.len = newLen;
    }
    updateZoomBar();
    scheduleDragRedraw();
  }

  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    redrawPreview(); // final draw, in case a coalesced frame was still pending
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// Discrete zoom for the +/- buttons — this UXP host never dispatches 'wheel'
// events into the panel DOM (confirmed live: click/mousedown are forwarded,
// wheel isn't), so there's no cursor position to anchor to here; zooms toward
// the window's current center instead.
function zoomBy(factor) {
  if (!analysis || !previewWindow) return;
  var center = previewWindow.start + previewWindow.len / 2;
  var newLen = clampNum(previewWindow.len * factor, MIN_ZOOM_SEC, analysis.duration);
  previewWindow.len = newLen;
  previewWindow.start = clampNum(center - newLen / 2, 0, Math.max(0, analysis.duration - newLen));
  updateZoomBar();
  redrawPreview();
}

// ── Playback (Premiere's own transport, not an in-panel <audio> element) ───────
//
// UXP's webview has no functional <audio> element here — confirmed live:
// document.createElement('audio') returns a node without even play()/pause().
// Real audio has to come from Premiere itself, so this drives the sequence's
// own playhead/transport via the premierepro scripting API instead. Nothing in
// this codebase has touched playback before, and Adobe's docs for this API
// surface are thin on transport control specifically, so — same as marker
// creation/color/removal elsewhere in this file — candidate method names are
// probed and verified rather than assumed. Position-set is verified by reading
// the position back; the play-trigger is verified by checking whether the
// playhead actually advances afterward, since "no exception thrown" proved to
// be a false signal of success with the <audio> element too.

var previewPlayheadRel = null; // clip-relative seconds of our last-known Premiere playhead position
var playheadPollHandle = null; // rAF (or setTimeout fallback) handle while following continuous playback

var _setPositionSig = null;

async function setSequencePosition(sequence, sequenceTimeSec) {
  if (!sequence) return false;
  await ensureTTCtor(sequence);
  var tt;
  try { tt = makeTickTime(Math.max(0, sequenceTimeSec)); }
  catch (e) { console.log('[BM] setSequencePosition: makeTickTime failed:', e && e.message); return false; }

  var candidates = _setPositionSig !== null ? [_setPositionSig] : [0, 1];
  for (var s = 0; s < candidates.length; s++) {
    var idx = candidates[s];
    try {
      if (idx === 0 && typeof sequence.setPlayerPosition === 'function') await sequence.setPlayerPosition(tt);
      else if (idx === 1 && typeof sequence.setPosition === 'function') await sequence.setPosition(tt);
      else continue;
    } catch (e) {
      console.log('[BM] setSequencePosition sig#' + idx + ' failed:', e && e.message);
      continue;
    }
    if (_setPositionSig === null) {
      _setPositionSig = idx;
      console.log('[BM] sequence position-set signature #' + idx + ' confirmed');
    }
    return true;
  }
  return false;
}

var PLAY_CANDIDATES = [
  function (seq) { return seq.play(); },
  function (seq) { return seq.setPlaying(true); },
  function (seq) { return seq.startPlaying(); }
];
var _playSig = null;
var _playProbed = false;

// Tries each candidate in turn and waits 500ms to see whether the playhead
// actually moved — a promise resolving (or no exception) isn't proof anything
// really started, exactly as the <audio>.play() case showed. Result (including
// "none of them work") is cached so repeat Play clicks don't re-probe.
async function tryStartSequencePlayback(sequence) {
  if (_playProbed) {
    if (_playSig == null) return false;
    try { await PLAY_CANDIDATES[_playSig](sequence); return true; }
    catch (e) { console.log('[BM] cached play signature failed on reuse:', e && e.message); return false; }
  }

  var before = null;
  try { before = String((await sequence.getPlayerPosition()).ticks); } catch (_) {}

  for (var i = 0; i < PLAY_CANDIDATES.length; i++) {
    try { await PLAY_CANDIDATES[i](sequence); }
    catch (e) { console.log('[BM] play candidate #' + i + ' threw:', e && e.message); continue; }

    await sleep(500);
    var advanced = false;
    try { advanced = before != null && String((await sequence.getPlayerPosition()).ticks) !== before; }
    catch (_) {}
    console.log('[BM] play candidate #' + i + ' ran; playhead advanced=' + advanced);

    if (advanced) {
      _playSig = i;
      _playProbed = true;
      console.log('[BM] sequence play signature #' + i + ' confirmed (playhead advances)');
      return true;
    }
    try { if (typeof sequence.pause === 'function') await sequence.pause(); } catch (_) {}
  }
  _playProbed = true;
  _playSig = null;
  console.log('[BM] no play-trigger candidate advanced the playhead — continuous playback not scriptable here');
  return false;
}

var PAUSE_CANDIDATES = [
  function (seq) { return seq.pause(); },
  function (seq) { return seq.setPlaying(false); },
  function (seq) { return seq.stopPlaying(); }
];
var _pauseSig = null;

async function tryPauseSequencePlayback(sequence) {
  var candidates = _pauseSig !== null ? [_pauseSig] : [0, 1, 2];
  for (var s = 0; s < candidates.length; s++) {
    var idx = candidates[s];
    try {
      await PAUSE_CANDIDATES[idx](sequence);
      if (_pauseSig === null) { _pauseSig = idx; console.log('[BM] sequence pause signature #' + idx + ' confirmed'); }
      return true;
    } catch (e) { console.log('[BM] pause candidate #' + idx + ' failed:', e && e.message); }
  }
  return false;
}

async function onCanvasClick(evt) {
  if (!analysis || !previewWindow) return;
  var canvas = evt.currentTarget;
  var rect = canvas.getBoundingClientRect();
  if (!rect || !rect.width) return;
  var xFrac = clampNum((evt.clientX - rect.left) / rect.width, 0, 1);
  var relSec = previewWindow.start + xFrac * previewWindow.len;
  if (anchorArmed) { setAnchor(relSec); return; }
  await seekTo(relSec);
}

async function seekTo(relSec) {
  if (!analysis || !analysis.sequence) return;
  var clamped = clampNum(relSec, 0, analysis.duration);
  var moved = await setSequencePosition(analysis.sequence, analysis.clipInfo.start + clamped);
  if (moved) {
    previewPlayheadRel = clamped;
    redrawPreview();
  } else {
    log('Could not move Premiere\'s playhead — no working position-set API found.', 'error');
  }
}

async function togglePlayback() {
  if (!analysis || !analysis.sequence) return;
  var playBtn = document.getElementById('playBtn');
  var sequence = analysis.sequence;

  if (playheadPollHandle == null) {
    var jumpRel = previewPlayheadRel != null ? previewPlayheadRel : previewWindow.start;
    playBtn.disabled = true;
    var moved = await setSequencePosition(sequence, analysis.clipInfo.start + jumpRel);
    if (!moved) {
      log('Could not move Premiere\'s playhead — no working position-set API found.', 'error');
      playBtn.disabled = false;
      return;
    }
    previewPlayheadRel = jumpRel;
    redrawPreview();

    var started = await tryStartSequencePlayback(sequence);
    playBtn.disabled = false;
    if (started) {
      playBtn.textContent = '⏸ Pause';
      startPlayheadPoll(sequence);
      log('Playing in Premiere from ' + jumpRel.toFixed(1) + 's.', 'info');
    } else {
      log('Continuous playback isn\'t scriptable in this Premiere version — moved Premiere\'s playhead to ' +
        jumpRel.toFixed(1) + 's instead. Click elsewhere on the waveform to scrub further.', 'info');
    }
  } else {
    stopPlayheadPoll();
    await tryPauseSequencePlayback(sequence);
    playBtn.textContent = '▶ Play';
  }
}

function startPlayheadPoll(sequence) {
  stopPlayheadPoll();
  function tick() {
    sequence.getPlayerPosition().then(function (pos) {
      var relSec = ticksToSeconds(pos.ticks) - analysis.clipInfo.start;
      previewPlayheadRel = relSec;
      if (relSec < 0 || relSec > analysis.duration) {
        stopPlayheadPoll();
        tryPauseSequencePlayback(sequence);
        document.getElementById('playBtn').textContent = '▶ Play';
        redrawPreview();
        return;
      }
      followPlayheadIntoView(relSec);
      redrawPreview();
      playheadPollHandle = rafFn(tick);
    }).catch(function (e) {
      console.log('[BM] playhead poll failed:', e && e.message);
      stopPlayheadPoll();
    });
  }
  playheadPollHandle = rafFn(tick);
}

function stopPlayheadPoll() {
  if (playheadPollHandle != null) { cafFn(playheadPollHandle); playheadPollHandle = null; }
}

// Keeps the zoom window following the playhead during playback rather than
// requiring manual re-panning as it plays past the visible range.
function followPlayheadIntoView(relSec) {
  if (!previewWindow || !analysis) return;
  if (relSec < previewWindow.start || relSec > previewWindow.start + previewWindow.len) {
    previewWindow.start = clampNum(relSec, 0, Math.max(0, analysis.duration - previewWindow.len));
    updateZoomBar();
  }
}

async function runClearMarkers() {
  try {
    var project = await ppro.Project.getActiveProject();
    if (!project) throw new Error('No active project — open a project first');

    var sequence = await project.getActiveSequence();
    if (!sequence) throw new Error('No active sequence — open a sequence in the timeline first');

    var clipInfo = await getSelectedClipInfo(sequence);
    if (!clipInfo) throw new Error('No clip selected — click an audio clip in the timeline first');

    var pi = await clipInfo.trackItem.getProjectItem();
    var clipItem = ppro.ClipProjectItem.queryCast(pi) || pi;
    var mc = await ppro.Markers.getMarkers(clipItem);
    var markers = await mc.getMarkers();
    if (!markers || markers.length === 0) { log('No markers on this clip.', 'info'); return; }

    log('Removing ' + markers.length + ' markers…', 'info');
    var removed = 0;
    for (var i = 0; i < markers.length; i++) {
      if (await removeClipMarker(project, mc, markers[i])) removed++;
    }

    if (removed === 0) throw new Error('Could not remove markers — all removal signatures failed (see console)');
    var left = await countMarkers(mc);
    log('Removed ' + removed + ' markers' + (left > 0 ? ' (' + left + ' left)' : '') + '.', 'success');

  } catch (err) {
    log('Error: ' + err.message, 'error');
    console.error('[BM]', err);
  }
}

// Beats on a fixed grid starting at the clip in-point — same time base as
// detectBeats output (seconds relative to the clip's first audible sample).
function beatsFromBpm(bpm, durationSec) {
  var period = 60 / bpm;
  var beats = [];
  for (var t = 0; t < durationSec; t += period) beats.push(t);
  return { bpm: bpm, beats: beats };
}

// ── Downbeat anchoring ─────────────────────────────────────────────────────────

// Derives analysis.allBeats (what preview + placement consume) from the current
// BPM and the un-anchored naturalBeats. With an anchor set, the grid is rebuilt
// at the current tempo so that a beat falls exactly on the anchor — spanning the
// whole clip, filling backward from the anchor to the start as well as forward —
// which corrects the detector's phase (or a manual grid's) to the beat the user
// pointed at. Cleared, it reverts to naturalBeats untouched.
function applyGrid() {
  if (!analysis) return;
  if (analysis.anchor != null && analysis.bpm > 0) {
    var period = 60 / analysis.bpm;
    var phase = ((analysis.anchor % period) + period) % period;
    var beats = [];
    for (var t = phase; t < analysis.duration + 1e-9; t += period) beats.push(t);
    analysis.allBeats = beats;
  } else {
    analysis.allBeats = analysis.naturalBeats;
  }
}

function toggleAnchorArm() {
  if (!analysis) return;
  anchorArmed = !anchorArmed;
  updateAnchorUi();
}

function setAnchor(relSec) {
  if (!analysis) return;
  analysis.anchor = clampNum(relSec, 0, analysis.duration);
  anchorArmed = false;
  applyGrid();
  document.getElementById('placeBtn').disabled = false;
  updateAnchorUi();
  redrawPreview();
  log('Beat 1 anchored at ' + analysis.anchor.toFixed(3) + 's — grid re-phased.', 'success');
}

function clearAnchor() {
  if (!analysis || analysis.anchor == null) { anchorArmed = false; updateAnchorUi(); return; }
  analysis.anchor = null;
  anchorArmed = false;
  applyGrid();
  updateAnchorUi();
  redrawPreview();
  log('Anchor cleared — reverted to ' + (analysis.detected ? 'detected' : 'grid') + ' phase.', 'info');
}

function updateAnchorUi() {
  var btn = document.getElementById('anchorBtn');
  var clearBtn = document.getElementById('anchorClearBtn');
  var info = document.getElementById('anchorInfo');
  if (!btn || !clearBtn) return;
  btn.disabled = !analysis;
  clearBtn.disabled = !analysis || analysis.anchor == null;
  btn.textContent = anchorArmed ? '◎ Click waveform…' : '◎ Set Beat 1';
  if (anchorArmed) btn.classList.add('armed'); else btn.classList.remove('armed');
  if (info) {
    if (analysis && analysis.anchor != null) info.textContent = 'Beat 1 @ ' + analysis.anchor.toFixed(2) + 's';
    else info.textContent = anchorArmed ? 'Click the downbeat in the waveform' : '';
  }
}

// ── Clip selection ────────────────────────────────────────────────────────────

async function getSelectedClipInfo(sequence) {
  try {
    var sel = await sequence.getSelection();
    if (sel) {
      var items;
      if (typeof sel.getTrackItems === 'function')   items = await sel.getTrackItems();
      else if (typeof sel.getItems === 'function')   items = await sel.getItems();
      else if (Array.isArray(sel))                   items = sel;

      if (items && items.length > 0) {
        var item      = items[0];
        var startTime = await item.getStartTime();
        var endTime   = await item.getEndTime();
        return {
          start: ticksToSeconds(startTime.ticks), end: ticksToSeconds(endTime.ticks),
          startTickTime: startTime, endTickTime: endTime, trackItem: item
        };
      }
    }
    var audioCount = await sequence.getAudioTrackCount();
    var videoCount = await sequence.getVideoTrackCount();
    for (var t = 0; t < audioCount; t++) {
      var found = await findSelectedInTrack(await sequence.getAudioTrack(t));
      if (found) return found;
    }
    for (var t = 0; t < videoCount; t++) {
      var found = await findSelectedInTrack(await sequence.getVideoTrack(t));
      if (found) return found;
    }
  } catch (e) { console.warn('[BM] selection probe:', e); }
  return null;
}

async function findSelectedInTrack(track) {
  if (!track) return null;
  try {
    var coll = track.trackItems || track.clips;
    if (!coll) return null;
    var n = coll.numItems !== undefined ? coll.numItems : (coll.length || 0);
    for (var c = 0; c < n; c++) {
      var clip = coll[c];
      if (!clip) continue;
      var sel = typeof clip.getIsSelected === 'function' ? await clip.getIsSelected()
              : typeof clip.isSelected    === 'function' ? await clip.isSelected()
              : clip.selected;
      if (sel) {
        var st = await clip.getStartTime(), et = await clip.getEndTime();
        return { start: ticksToSeconds(st.ticks), end: ticksToSeconds(et.ticks),
                 startTickTime: st, endTickTime: et, trackItem: clip };
      }
    }
  } catch (_) {}
  return null;
}

// ── Audio loading ─────────────────────────────────────────────────────────────

async function loadClipAudio(clipInfo) {
  var trackItem = clipInfo.trackItem;

  var pi       = await trackItem.getProjectItem();
  var clipItem = ppro.ClipProjectItem.queryCast(pi) || ppro.ClipProjectItem.cast(pi);
  if (!clipItem) throw new Error('Cannot get media info — is this a real media clip?');

  var filePath = await clipItem.getMediaFilePath();
  if (!filePath) throw new Error('Cannot get source file path');
  log('Source: ' + filePath.split('/').pop(), 'info');

  var sourceStart = 0, sourceEnd = null;
  try {
    var ip = typeof trackItem.getInPoint  === 'function' ? await trackItem.getInPoint()  : null;
    var op = typeof trackItem.getOutPoint === 'function' ? await trackItem.getOutPoint() : null;
    if (ip && ip.ticks) sourceStart = ticksToSeconds(ip.ticks);
    if (op && op.ticks) sourceEnd   = ticksToSeconds(op.ticks);
  } catch (_) {}

  var ext = filePath.toLowerCase().replace(/^.*\./, '');

  if (ext === 'wav' || ext === 'wave') {
    log('Reading WAV…', 'info');
    var wavEntry = await openFileByPath(filePath);
    var wavRaw   = await wavEntry.read({ format: formats.binary });
    var parsed   = parseWav(rawToArrayBuffer(wavRaw));
    return sliceAudio(parsed.samples, parsed.sampleRate, sourceStart, sourceEnd);
  }

  if (ext === 'mp3') {
    log('Reading MP3…', 'info');
    var mp3Entry = await openFileByPath(filePath);
    var mp3Raw   = await mp3Entry.read({ format: formats.binary });
    var parsedMp3 = parseMp3(rawToArrayBuffer(mp3Raw));
    return sliceAudio(parsedMp3.samples, parsedMp3.sampleRate, sourceStart, sourceEnd);
  }

  log('Transcoding to WAV…', 'info');
  var wavPath   = await transcodeToWav(filePath, clipItem);
  var wavEntry2 = await openFileByPath(wavPath);
  var wavRaw2   = await wavEntry2.read({ format: formats.binary });
  var parsed2   = parseWav(rawToArrayBuffer(wavRaw2));
  try { await wavEntry2.delete(); } catch (_) {}
  return sliceAudio(parsed2.samples, parsed2.sampleRate, sourceStart, sourceEnd);
}

// ── Transcoding ───────────────────────────────────────────────────────────────

async function transcodeToWav(srcPath, clipItem) {
  var manager    = await ppro.EncoderManager.getManager();
  var srcDirPath = srcPath.substring(0, srcPath.lastIndexOf('/'));
  var srcBase    = srcPath.substring(srcPath.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
  var outFileName = 'beatmarker_tmp.wav';

  // Primary candidate: same dir as source, fixed name.
  // Also try source-basename.wav (AME default when no output path is honoured).
  var primaryPath  = srcDirPath + '/' + outFileName;
  var fallbackPath = srcDirPath + '/' + srcBase + '.wav';
  console.log('[BM] polling primary:', primaryPath);
  console.log('[BM] polling fallback:', fallbackPath);

  // Delete stale files so we can detect fresh AME output by file appearance.
  for (var dp = 0; dp < [primaryPath, fallbackPath].length; dp++) {
    try { var st = await openFileByPath([primaryPath, fallbackPath][dp]); await st.delete(); } catch(_) {}
  }

  var QUEUE = ppro.EncoderManager.EXPORT_QUEUE_TO_APP;
  var IMMED = ppro.EncoderManager.EXPORT_IMMEDIATELY;
  var launched = false, usedImmed = false;

  try {
    var val = await manager.encodeProjectItem(clipItem, primaryPath, QUEUE);
    launched = val !== false;
    console.log('[BM] QUEUE_TO_APP result:', val);
  } catch (e) { console.log('[BM] QUEUE_TO_APP err:', e && e.message); }

  if (!launched) {
    try {
      var val2 = await manager.encodeProjectItem(clipItem, primaryPath, IMMED);
      launched = val2 !== false;
      usedImmed = true;
      console.log('[BM] EXPORT_IMMEDIATELY result:', val2);
    } catch (e2) { throw new Error('Encoder rejected: ' + (e2 && e2.message)); }
  }

  if (!launched) throw new Error('Encoder returned false — convert source to WAV and re-import.');

  log(usedImmed
    ? 'Adobe Media Encoder opened — click ▶ Start Queue, then wait here.'
    : 'Render queued — waiting for WAV output…', 'info');

  // Poll for up to 5 min at 1-second intervals.
  // Check both the primary path and the fallback (source-basename.wav).
  var candidates = [primaryPath, fallbackPath];
  for (var poll = 0; poll < 300; poll++) {
    await sleep(1000);
    for (var ci = 0; ci < candidates.length; ci++) {
      try {
        var entry = await openFileByPath(candidates[ci]);
        var data  = await entry.read({ format: formats.binary });
        var size  = rawToArrayBuffer(data).byteLength;
        if (size > 44) {
          log('Transcode complete (' + Math.round(size / 1024) + ' KB)', 'info');
          console.log('[BM] found at:', candidates[ci]);
          return candidates[ci];
        }
      } catch (_) {}
    }
    if (poll === 30)  log('Still waiting for AME… (up to 5 min total)', 'info');
    if (poll === 120) log('2 min elapsed — still waiting…', 'info');
    if (poll === 240) log('4 min elapsed — still waiting…', 'info');
  }

  throw new Error(
    'Transcode timed out (5 min). Checked:\n  ' + primaryPath + '\n  ' + fallbackPath +
    '\nIf AME exported elsewhere, convert the source to WAV and re-import.'
  );
}

// ── Marker creation ───────────────────────────────────────────────────────────

var _TTCtor = null;

var _markerSig = null;

// Creates a clip marker on the source ProjectItem at timeInSeconds (source time).
// The 2nd arg to createAddMarkerAction is the marker TYPE string (e.g. "Comment"),
// not a comment — an empty type creates an action that silently no-ops at commit.
// On the first call we probe candidate signatures and verify via marker count;
// the working one is cached for the rest of the run.
async function ensureTTCtor(sequence) {
  if (!_TTCtor) {
    try { _TTCtor = (await sequence.getPlayerPosition()).constructor; } catch (_) {}
  }
  return _TTCtor;
}

async function createClipMarker(project, sequence, markersCollection, timeInSeconds, name) {
  await ensureTTCtor(sequence);
  if (!_TTCtor) throw new Error('Cannot obtain TickTime constructor');
  var tt     = makeTickTime(timeInSeconds);
  var ttZero = makeTickTime(0);
  var mtype  = (ppro.Marker && ppro.Marker.MARKER_TYPE_COMMENT) || 'Comment';

  var candidates = _markerSig !== null ? [_markerSig] : [0, 1, 2, 3];
  for (var s = 0; s < candidates.length; s++) {
    var idx = candidates[s];
    var before = await countMarkers(markersCollection);

    var captured = null;
    try {
      await project.executeTransaction(async function(ca) {
        captured = await callMarkerSig(markersCollection, idx, name, mtype, tt, ttZero);
      });
    } catch (e) {
      console.log('[BM] sig#' + idx + ' create failed:', e && e.message);
      continue;
    }
    if (!captured) { console.log('[BM] sig#' + idx + ' returned no action'); continue; }

    // Commit synchronously — no await before ca.addAction.
    await project.executeTransaction(async function(ca) {
      ca.addAction(captured);
    });

    var after = await countMarkers(markersCollection);
    if (before < 0 || after > before) {
      if (_markerSig === null) {
        console.log('[BM] marker signature #' + idx + ' confirmed (count ' + before + ' → ' + after + ')');
        _markerSig = idx;
      }
      return findMarkerByName(markersCollection, name);
    }
    console.log('[BM] sig#' + idx + ' committed but marker count unchanged (' + before + ' → ' + after + ')');
  }

  throw new Error('Could not place a clip marker — all createAddMarkerAction signatures failed (see console)');
}

function callMarkerSig(mc, idx, name, mtype, tt, ttZero) {
  switch (idx) {
    case 0: return mc.createAddMarkerAction(name, mtype, tt);
    case 1: return mc.createAddMarkerAction(name, mtype, tt, ttZero);
    case 2: return mc.createAddMarkerAction(name, mtype, tt, ttZero, '');
    case 3: return mc.createAddMarkerAction(name, '', tt);
  }
}

async function findMarkerByName(mc, name) {
  try {
    var arr = await mc.getMarkers();
    if (!arr) return null;
    for (var i = arr.length - 1; i >= 0; i--) {
      var nm = typeof arr[i].getName === 'function' ? await arr[i].getName() : arr[i].name;
      if (nm === name) return arr[i];
    }
  } catch (_) {}
  return null;
}

// Applies a marker color by index (0=Green 1=Red 2=Purple 3=Orange 4=Yellow
// 5=White 6=Blue 7=Cyan). Probes candidate APIs on first use, verifies via
// getColorIndex, and warns once instead of failing the run if none work.
var _colorSig = null;
var _colorWarned = false;

async function setMarkerColor(project, marker, colorIndex) {
  var candidates = _colorSig !== null ? [_colorSig] : [0, 1, 2];
  for (var s = 0; s < candidates.length; s++) {
    var idx = candidates[s];
    try {
      if (idx === 0) {
        if (typeof marker.createSetColorIndexAction !== 'function') continue;
        var action = await marker.createSetColorIndexAction(colorIndex);
        if (!action) continue;
        await project.executeTransaction(function (ca) { ca.addAction(action); });
      } else if (idx === 1) {
        if (typeof marker.setColorByIndex !== 'function') continue;
        await marker.setColorByIndex(colorIndex);
      } else {
        if (typeof marker.setColorIndex !== 'function') continue;
        await marker.setColorIndex(colorIndex);
      }
    } catch (e) {
      console.log('[BM] color sig#' + idx + ' failed:', e && e.message);
      continue;
    }
    var got = -1;
    try {
      got = typeof marker.getColorIndex === 'function' ? Number(await marker.getColorIndex()) : colorIndex;
    } catch (_) { got = colorIndex; }
    if (got === colorIndex) {
      if (_colorSig === null) {
        console.log('[BM] marker color signature #' + idx + ' confirmed');
        _colorSig = idx;
      }
      return true;
    }
    console.log('[BM] color sig#' + idx + ' ran but colorIndex is ' + got);
  }
  if (!_colorWarned) {
    _colorWarned = true;
    log('Could not set marker color — markers placed with default color.', 'info');
  }
  return false;
}

// Removes one clip marker, probing candidate removal APIs on first use and
// verifying via marker count, mirroring createClipMarker.
var _removeSig = null;

async function removeClipMarker(project, mc, marker) {
  var candidates = _removeSig !== null ? [_removeSig] : [0, 1, 2];
  for (var s = 0; s < candidates.length; s++) {
    var idx = candidates[s];
    var before = await countMarkers(mc);

    var captured = null;
    try {
      await project.executeTransaction(async function (ca) {
        captured = await callRemoveSig(mc, marker, idx);
      });
    } catch (e) {
      console.log('[BM] remove sig#' + idx + ' failed:', e && e.message);
      continue;
    }
    if (captured) {
      try {
        await project.executeTransaction(async function (ca) { ca.addAction(captured); });
      } catch (e2) {
        console.log('[BM] remove sig#' + idx + ' commit failed:', e2 && e2.message);
        continue;
      }
    }

    var after = await countMarkers(mc);
    if (after >= 0 && before >= 0 && after < before) {
      if (_removeSig === null) {
        console.log('[BM] remove signature #' + idx + ' confirmed (count ' + before + ' → ' + after + ')');
        _removeSig = idx;
      }
      return true;
    }
    console.log('[BM] remove sig#' + idx + ' ran but marker count unchanged (' + before + ' → ' + after + ')');
  }
  return false;
}

function callRemoveSig(mc, marker, idx) {
  switch (idx) {
    case 0: return typeof mc.createRemoveMarkerAction === 'function' ? mc.createRemoveMarkerAction(marker) : null;
    case 1: return typeof mc.createDeleteMarkerAction === 'function' ? mc.createDeleteMarkerAction(marker) : null;
    case 2: return typeof mc.removeMarker === 'function' ? mc.removeMarker(marker) : null;
  }
}

async function countMarkers(mc) {
  try {
    var arr = await mc.getMarkers();
    if (arr && typeof arr.length === 'number') return arr.length;
  } catch (_) {}
  return -1;
}

// The bare TickTime constructor may ignore its arguments and produce a
// zero-valued instance — never trust construction without reading the value
// back. Probes static factories first, caches whichever verifiably works.
var _ttFactory = null;
var _ttStaticsLogged = false;

function makeTickTime(sec) {
  var C = _TTCtor;
  if (!_ttStaticsLogged) {
    _ttStaticsLogged = true;
    try { console.log('[BM] TickTime statics:', Object.getOwnPropertyNames(C).join(', ')); } catch (_) {}
  }
  var ticksStr  = String(secondsToTicks(sec));
  var factories = [
    ['createWithTicks',   function () { return C.createWithTicks(ticksStr); }],
    ['createWithSeconds', function () { return C.createWithSeconds(sec); }],
    ['ctorTicksSeconds',  function () { return new C(ticksStr, sec); }],
    ['ctorSeconds',       function () { return new C(sec); }],
  ];
  // Prefer the factory that already verified on a nonzero value.
  if (_ttFactory !== null) {
    factories.sort(function (a, b) { return (b[0] === _ttFactory) - (a[0] === _ttFactory); });
  }
  for (var f = 0; f < factories.length; f++) {
    var tt;
    try { tt = factories[f][1](); } catch (_) { continue; }
    var got;
    try { got = Number(tt.seconds); } catch (_) { continue; }
    if (isNaN(got) || Math.abs(got - sec) > 0.001) continue;
    // Only cache on nonzero values — a broken factory returning a zero TickTime
    // would falsely "verify" when sec is 0.
    if (_ttFactory === null && sec > 0.001) {
      _ttFactory = factories[f][0];
      console.log('[BM] TickTime factory verified:', _ttFactory, '(' + got.toFixed(3) + ' s)');
    }
    return tt;
  }
  throw new Error('Cannot construct a TickTime holding ' + sec.toFixed(3) + ' s (see console for available statics)');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function openFileByPath(absPath) {
  // absPath starts with '/', so 'file://' + absPath = 'file:///...' (3 slashes, correct)
  try       { return await localFs.getEntryWithUrl('file://' + absPath); }
  catch (_) { return await localFs.getEntryWithUrl('file://' + encodeURI(absPath)); }
}

function rawToArrayBuffer(raw) {
  if (raw instanceof ArrayBuffer) return raw;
  if (raw && raw.buffer) return raw.buffer;
  throw new Error('Unexpected file read type: ' + typeof raw);
}

function sliceAudio(samples, sampleRate, srcStart, srcEnd) {
  var s0 = Math.round(srcStart * sampleRate);
  var s1 = srcEnd != null
    ? Math.min(Math.round(srcEnd * sampleRate), samples.length)
    : samples.length;
  return {
    samples:    (s0 === 0 && s1 === samples.length) ? samples : samples.slice(s0, s1),
    sampleRate: sampleRate
  };
}

function sleep(ms)             { return new Promise(function (r) { setTimeout(r, ms); }); }
function secondsToTicks(sec)   { return Math.round(sec * TICKS_PER_SECOND); }
function ticksToSeconds(ticks) { return Number(ticks) / TICKS_PER_SECOND; }

function log(message, type) {
  var el = document.getElementById('statusLog');
  if (!el) { console.log('[BM]', message); return; }
  var line = document.createElement('div');
  line.className   = 'log-' + (type || 'info');
  line.textContent = message;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}
