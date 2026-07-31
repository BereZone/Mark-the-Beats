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

// The most recent Place Markers batch: { mc, markers } — the markers collection
// and the handles created, so Undo can remove exactly those and nothing else.
// Null when there's nothing to undo.
var lastPlacement = null;

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

// 'in' | 'out' while a range boundary is armed: the next waveform click sets that
// end of the placement range (analysis.rangeStart / rangeEnd) instead of seeking.
// null when nothing is armed.
var rangeArm = null;

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
  document.getElementById('previewCanvas').addEventListener('mousedown', onCanvasMouseDown);
  document.getElementById('previewCanvas').addEventListener('click', onCanvasClick);
  document.getElementById('anchorBtn').addEventListener('click', toggleAnchorArm);
  document.getElementById('anchorClearBtn').addEventListener('click', clearAnchor);
  document.getElementById('rangeInBtn').addEventListener('click', function () { toggleRangeArm('in'); });
  document.getElementById('rangeOutBtn').addEventListener('click', function () { toggleRangeArm('out'); });
  document.getElementById('rangeClearBtn').addEventListener('click', clearRange);
  // Confirmed live: this UXP host never dispatches 'wheel' events into the panel
  // DOM at all (click/mousedown are forwarded, wheel isn't — a gap in the native
  // embedding, not a JS-side binding issue, so no event-registration trick fixes
  // it). Zoom is click/drag-only: the zoom bar's edge handles, or the +/− buttons.
  document.getElementById('undoBtn').addEventListener('click', function () {
    var btn = document.getElementById('undoBtn');
    btn.disabled = true;
    runUndoPlaceMarkers().finally(function () {
      // Re-enable only if the batch wasn't fully undone; a clean undo clears it.
      btn.disabled = !lastPlacement;
    });
  });
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
      anchor: null, rangeStart: null, rangeEnd: null,
      detected: detected, waveform: waveform
    };
    anchorArmed = false;
    rangeArm = null;
    applyGrid();

    stopPlayheadPoll();
    stopInPanelSource();
    stopPremiereFollow();
    panelStartedPlayback = false;
    previewWindow = { start: 0, len: Math.min(DEFAULT_ZOOM_SEC, duration) };
    previewPlayheadRel = null;

    document.getElementById('placeBtn').disabled = false;
    updateAnchorUi();
    updateRangeUi();
    document.getElementById('zoomBar').classList.remove('disabled');
    document.getElementById('zoomInBtn').disabled = false;
    document.getElementById('zoomOutBtn').disabled = false;
    document.getElementById('playBtn').disabled = false;
    document.getElementById('playBtn').textContent = '▶ Play';
    updateZoomBar();
    redrawPreview();
    startPremiereFollow();
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
  stopInPanelSource();
  stopPremiereFollow();
  panelStartedPlayback = false;
  previewPlayheadRel = null;
  var playBtn = document.getElementById('playBtn');
  playBtn.disabled = true;
  playBtn.textContent = '▶ Play';
  anchorArmed = false;
  rangeArm = null;
  updateAnchorUi();
  updateRangeUi();
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

    // Same generator the preview draws from, so placement matches the preview exactly.
    // Each created marker is kept so Undo can remove exactly this batch.
    var placed = [];
    var markerBeats = computeMarkerBeats();
    for (var i = 0; i < markerBeats.length; i++) {
      var sourceTimeSec = sourceStart + markerBeats[i];
      if (sourceTimeSec < 0) continue;
      var marker = await createClipMarker(project, sequence, markersCollection, sourceTimeSec, prefix + ' ' + (count + 1));
      count++;
      if (marker) {
        placed.push(marker);
        if (colorIndex >= 0) await setMarkerColor(project, marker, colorIndex);
      }
    }

    var afterCount = await countMarkers(markersCollection);
    if (beforeCount >= 0 && afterCount >= 0) {
      log('Markers on clip: ' + beforeCount + ' → ' + afterCount, 'info');
    }

    // Remember this batch for Undo (only markers we could capture a handle to).
    lastPlacement = placed.length ? { mc: markersCollection, markers: placed } : null;
    document.getElementById('undoBtn').disabled = !lastPlacement;

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

// Marker positions in clip-relative seconds — offset applied, clipped to the clip.
// Built from the beat grid's phase at the selected interval, expressed in
// beats-per-marker: 1 = every beat, 2/3/4… = every Nth beat (sparser), and the
// sub-beat options 0.5 = every ½ beat (8th notes), 0.25 = every ¼ beat (16th).
// Both the preview and Place Markers call this, so what's drawn is what's placed.
function computeMarkerBeats() {
  if (!analysis || !analysis.bpm) return [];
  var interval  = parseFloat(document.getElementById('nthBeat').value) || 1;
  var offsetSec = (parseFloat(document.getElementById('offset').value) || 0) / 1000;
  var period    = 60 / analysis.bpm;
  var spacing   = period * interval;
  if (!(spacing > 0)) return [];
  // allBeats[0] is the grid phase in [0, period) — the detected phase, 0 for a
  // manual grid, or the downbeat anchor's phase. Step from the first on-grid
  // point at or after 0 so sub-beat markers stay aligned to the beats.
  var phase = analysis.allBeats.length ? analysis.allBeats[0] : 0;
  var start = ((phase % spacing) + spacing) % spacing;
  // Placement range: null endpoints mean "clip start" / "clip end", so a range
  // with only one side set still bounds placement (e.g. In only = In→end). The
  // final marker time (offset applied) is what's tested, so the marker's actual
  // position is what stays inside the range.
  var lo = analysis.rangeStart != null ? analysis.rangeStart : 0;
  var hi = analysis.rangeEnd   != null ? analysis.rangeEnd   : analysis.duration;
  var out = [];
  for (var t = start; t < analysis.duration + 1e-9; t += spacing) {
    var tt = t + offsetSec;
    if (tt < 0 || tt > analysis.duration) continue;
    if (tt < lo - 1e-9 || tt > hi + 1e-9) continue;
    out.push(tt);
  }
  return out;
}

function redrawPreview() {
  if (!analysis || !previewWindow) return;
  var colorIndex = parseInt(document.getElementById('markerColor').value, 10);

  var previewBeats = computeMarkerBeats();

  drawWaveformPreview(analysis.waveform, analysis.duration, previewBeats, colorIndex, previewWindow, previewPlayheadRel, analysis.anchor, analysis.rangeStart, analysis.rangeEnd);
  updatePlayheadOverlay();

  var info = document.getElementById('previewInfo');
  if (info) {
    info.textContent = analysis.bpm.toFixed(1) + ' BPM — ' + previewBeats.length + ' markers — showing ' +
      previewWindow.start.toFixed(1) + 's–' + (previewWindow.start + previewWindow.len).toFixed(1) +
      's of ' + analysis.duration.toFixed(1) + 's';
  }
}

// Set once if ctx.scale() throws on this host, so we stop retrying it every frame
// (retrying would reallocate the backing store each redraw — the very flicker we
// avoid below).
var _canvasScaleFailed = false;

function drawWaveformPreview(waveform, durationSec, beatsSec, colorIndex, win, playheadRel, anchorRel, rangeStart, rangeEnd) {
  var canvas = document.getElementById('previewCanvas');
  if (!canvas || !durationSec || !win) return;

  var cssWidth  = canvas.clientWidth  || 280;
  var cssHeight = canvas.clientHeight || 64;
  var ctx = canvas.getContext('2d');

  // Only resize the backing store when the target size actually changes. Assigning
  // canvas.width/height reallocates and clears it (and resets the transform), so
  // doing it every redraw made the canvas flash dark during playback, where we
  // repaint ~10×/sec. When the size is unchanged we just repaint over the existing
  // store; the scale() applied on the last resize persists. UXP's canvas has no
  // setTransform (only scale), and may lack scale too — fall back to a 1× store.
  var dpr = window.devicePixelRatio || 1;
  var useDpr = dpr !== 1 && !_canvasScaleFailed && typeof ctx.scale === 'function';
  var wantW = useDpr ? Math.round(cssWidth * dpr)  : cssWidth;
  var wantH = useDpr ? Math.round(cssHeight * dpr) : cssHeight;
  if (canvas.width !== wantW || canvas.height !== wantH) {
    canvas.width  = wantW;
    canvas.height = wantH;
    if (useDpr) {
      try { ctx.scale(dpr, dpr); }
      catch (_) { _canvasScaleFailed = true; canvas.width = cssWidth; canvas.height = cssHeight; }
    }
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

  // Placement range: dim the excluded parts of the window and draw green In/Out
  // boundary lines. Only drawn when a range is actually set (either side). The
  // dimming makes it obvious at a glance which stretch of the clip will get
  // markers, since the beat ticks below are already filtered to the range.
  if (rangeStart != null || rangeEnd != null) {
    var relToX = function (rel) { return ((rel - winStart) / winLen) * cssWidth; };
    var lo = rangeStart != null ? rangeStart : 0;
    var hi = rangeEnd   != null ? rangeEnd   : durationSec;
    ctx.fillStyle = 'rgba(16,16,16,0.6)';
    var loX = clampNum(relToX(lo), 0, cssWidth);
    var hiX = clampNum(relToX(hi), 0, cssWidth);
    if (loX > 0)        ctx.fillRect(0, 0, loX, cssHeight);
    if (hiX < cssWidth) ctx.fillRect(hiX, 0, cssWidth - hiX, cssHeight);
    ctx.fillStyle = '#3fae6b';
    if (rangeStart != null && lo >= winStart && lo <= winEnd) {
      var sx = Math.round(relToX(lo));
      ctx.fillRect(sx, 0, 2, cssHeight);
      ctx.fillRect(sx, 0, 6, 5);
    }
    if (rangeEnd != null && hi >= winStart && hi <= winEnd) {
      var ex = Math.round(relToX(hi));
      ctx.fillRect(ex, 0, 2, cssHeight);
      ctx.fillRect(ex - 4, 0, 6, 5);
    }
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
  // The playhead is drawn as the #previewPlayhead overlay (see updatePlayheadOverlay),
  // not on the canvas, so it can move during playback without repainting the waveform.
}

// Positions the playhead overlay for the current window; hides it when there's no
// playhead or it's scrolled out of view. Pure CSS, so it's safe to call every tick.
function updatePlayheadOverlay() {
  var el = document.getElementById('previewPlayhead');
  if (!el) return;
  if (previewPlayheadRel == null || !previewWindow || !(previewWindow.len > 0)) {
    el.style.display = 'none';
    return;
  }
  var frac = (previewPlayheadRel - previewWindow.start) / previewWindow.len;
  if (frac < 0 || frac > 1) { el.style.display = 'none'; return; }
  el.style.left = (frac * 100) + '%';
  el.style.display = 'block';
}

function showPreviewMessage(msg) {
  var info = document.getElementById('previewInfo');
  if (info) info.textContent = msg;
  var ph = document.getElementById('previewPlayhead');
  if (ph) ph.style.display = 'none';
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

// Smallest the zoom thumb is ever drawn, in pixels, so it stays easy to grab even
// when the visible window is a tiny slice of a long clip. This floors only the
// thumb's drawn width, not the actual zoom (previewWindow.len is untouched).
var MIN_THUMB_PX = 30;

// Reflects previewWindow onto the zoom bar's thumb position/width. Width is a
// percentage of the full clip duration but floored to MIN_THUMB_PX so it's
// grabbable; the left offset is then clamped against that (possibly wider) drawn
// width so the thumb never spills past the end of the bar.
function updateZoomBar() {
  var thumb = document.getElementById('zoomThumb');
  var bar   = document.getElementById('zoomBar');
  if (!thumb || !bar || !analysis || !previewWindow || !analysis.duration) return;
  var barW = bar.getBoundingClientRect().width || 150;
  var minPct = clampNum((MIN_THUMB_PX / barW) * 100, 0, 100);
  var widthPct = clampNum((previewWindow.len / analysis.duration) * 100, minPct, 100);
  var leftPct  = clampNum((previewWindow.start / analysis.duration) * 100, 0, Math.max(0, 100 - widthPct));
  thumb.style.left  = leftPct + '%';
  thumb.style.width = widthPct + '%';
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
// wheel isn't), so there's no cursor position to anchor to. Zooms centered on the
// playhead when there is one (so you can zoom straight in on the current position),
// falling back to the window's center before anything has played.
function zoomBy(factor) {
  if (!analysis || !previewWindow) return;
  var focus = (previewPlayheadRel != null) ? previewPlayheadRel : (previewWindow.start + previewWindow.len / 2);
  var newLen = clampNum(previewWindow.len * factor, MIN_ZOOM_SEC, analysis.duration);
  previewWindow.len = newLen;
  previewWindow.start = clampNum(focus - newLen / 2, 0, Math.max(0, analysis.duration - newLen));
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

// True while the panel's Play button started Premiere's transport, so pause routes
// back to it. (Playback the user starts directly in Premiere is followed but not
// "owned" by the panel, so the panel won't pause it.)
var panelStartedPlayback = false;

// Generation token for the Premiere-playhead follow loop: bumping it retires any
// running loop (used on stop and on re-analyze) without leaving a second loop alive.
var _followGen = 0;
var _lastFollowTicks = null;

// Dead-reckoning state for the follow loop. Between the sparse bridge polls the
// playhead is derived locally from the wall clock at the rate measured across the
// last two polls, so the overlay stays smooth without asking Premiere every frame.
var _followRate       = 0;    // sequence-seconds per wall-clock second; 0 = not advancing
var _followAnchorRel  = 0;    // clip-relative position reported by the last poll
var _followAnchorWall = 0;    // Date.now() at that poll
var _followWasMoving  = false;
var _followRafHandle  = null;
var _followFailures   = 0;

// ── In-panel audio (Web Audio) ──────────────────────────────────────────────
//
// Why CEP-based tools ("Beat Marker Pro" and the like) can play sound in the
// panel and older UXP notes here said this one can't: CEP extensions run in a
// full embedded Chromium, so <audio> and Web Audio just work. UXP runs a
// stripped engine — its <audio> element is inert (createElement('audio') returns
// a node without play()/pause()), which is why playback fell back to driving
// Premiere's own transport. But we already hold the decoded PCM (analysis.waveform)
// whenever a clip was read/transcoded, so if this UXP build exposes AudioContext
// at all we can feed those samples straight to the speakers from the panel. It's
// probed and cached like every other host API here; if AudioContext is absent we
// silently keep the Premiere-transport path, so nothing regresses.

var _audioCtx = null;
var _audioCtxProbed = false;

// Live in-panel playback: the running BufferSource plus the anchor used to derive
// the current position from the context clock (start(0, offset) gives no
// position readout of its own).
var webAudio = { source: null, buffer: null, bufferFor: null, startCtxTime: 0, startOffset: 0, playing: false };

function getAudioContext() {
  if (_audioCtxProbed) return _audioCtx;
  _audioCtxProbed = true;
  var Ctor = (typeof AudioContext !== 'undefined' && AudioContext) ||
             (typeof webkitAudioContext !== 'undefined' && webkitAudioContext) ||
             (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) || null;
  if (!Ctor) { console.log('[BM] no AudioContext in this UXP host — using Premiere transport for playback'); return null; }
  try { _audioCtx = new Ctor(); console.log('[BM] AudioContext available — in-panel audio enabled'); }
  catch (e) { console.log('[BM] AudioContext ctor threw:', e && e.message); _audioCtx = null; }
  // A fresh context starts running and claims the output device. Nothing is
  // connected to it yet — and seekTo probes for a context on every waveform click,
  // long before anything plays — so park it immediately and let playback resume it.
  suspendAudioContext();
  return _audioCtx;
}

// Builds (and caches per analysis) an AudioBuffer from the decoded PCM. The
// waveform is already sliced to the clip's in/out, so buffer time == clip-relative
// time == the preview's own time base.
function getPlaybackBuffer(ctx) {
  if (!analysis || !analysis.waveform || !analysis.waveform.samples || !analysis.waveform.samples.length) return null;
  if (webAudio.buffer && webAudio.bufferFor === analysis) return webAudio.buffer;
  var wf = analysis.waveform;
  var buf;
  try {
    buf = ctx.createBuffer(1, wf.samples.length, wf.sampleRate);
    var ch = buf.getChannelData(0);
    if (wf.samples instanceof Float32Array && typeof ch.set === 'function') ch.set(wf.samples);
    else for (var i = 0; i < wf.samples.length; i++) ch[i] = wf.samples[i];
  } catch (e) { console.log('[BM] createBuffer failed:', e && e.message); return null; }
  webAudio.buffer = buf;
  webAudio.bufferFor = analysis;
  return buf;
}

// Stops the source AND parks the context. A running AudioContext holds the audio
// output device open even with nothing connected to it, and this one otherwise
// stayed running for the rest of the session after the first in-panel play —
// contending with Premiere's own audio output for the whole edit. Suspending
// hands the device back; startInPanelPlayback resumes it on the next play.
// Callers that need the playback position must read it before calling this,
// since ctx.currentTime stops advancing once suspended.
function stopInPanelSource() {
  stopSourceOnly();
  suspendAudioContext();
}

// Tears down the source without parking the context — used when another source is
// about to take its place (a seek mid-playback), where suspending and immediately
// resuming would be a pointless device round trip on every scrub.
function stopSourceOnly() {
  if (webAudio.source) {
    try { webAudio.source.onended = null; webAudio.source.stop(); } catch (_) {}
    try { webAudio.source.disconnect(); } catch (_) {}
    webAudio.source = null;
  }
  webAudio.playing = false;
}

function suspendAudioContext() {
  if (_audioCtx && _audioCtx.state === 'running' && typeof _audioCtx.suspend === 'function') {
    try { _audioCtx.suspend(); } catch (_) {}
  }
}

// (Re)starts in-panel playback from offsetSec (clip-relative). Returns false if
// the buffer or the source couldn't be built, so the caller can fall back to the
// Premiere transport within the same click.
async function startInPanelPlayback(ctx, offsetSec) {
  var buffer = getPlaybackBuffer(ctx);
  if (!buffer) return false;
  stopSourceOnly();
  try { if (ctx.state === 'suspended' && typeof ctx.resume === 'function') await ctx.resume(); } catch (_) {}
  var off = clampNum(offsetSec, 0, analysis.duration);
  var src;
  try {
    src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start(0, off);
  } catch (e) {
    console.log('[BM] in-panel start failed:', e && e.message);
    suspendAudioContext();
    return false;
  }
  webAudio.source = src;
  webAudio.startCtxTime = ctx.currentTime;
  webAudio.startOffset = off;
  webAudio.playing = true;
  return true;
}

function inPanelPositionSec(ctx) {
  return webAudio.startOffset + (ctx.currentTime - webAudio.startCtxTime);
}

function startInPanelPoll(ctx) {
  stopPlayheadPoll();
  function tick() {
    var rel = inPanelPositionSec(ctx);
    if (rel >= analysis.duration) {
      previewPlayheadRel = analysis.duration;
      stopInPanelSource();
      stopPlayheadPoll();
      document.getElementById('playBtn').textContent = '▶ Play';
      redrawPreview();
      return;
    }
    previewPlayheadRel = rel;
    if (followPlayheadIntoView(rel)) redrawPreview(); else updatePlayheadOverlay();
    playheadPollHandle = rafFn(tick);
  }
  playheadPollHandle = rafFn(tick);
}

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

// Set true when a canvas mousedown turns into a pan drag, so the trailing click
// event (which fires after mouseup) is swallowed instead of also seeking. Reset
// on every fresh mousedown, so a click that never fires can't leave it stuck.
var _canvasDragged = false;

// Drag anywhere on the waveform to slide the visible window (grab-and-scroll:
// dragging the content right reveals earlier audio). Disabled while a boundary is
// armed so those clicks still set the anchor/range point. A press with no real
// movement falls through to onCanvasClick as a seek.
function onCanvasMouseDown(evt) {
  if (!analysis || !previewWindow) return;
  if (rangeArm || anchorArmed) return;
  var canvas = evt.currentTarget;
  var rect = canvas.getBoundingClientRect();
  if (!rect || !rect.width) return;
  if (typeof evt.preventDefault === 'function') evt.preventDefault();

  _canvasDragged = false;
  var startX = evt.clientX;
  var startWinStart = previewWindow.start;
  var duration = analysis.duration;

  function onMove(mv) {
    var dxPix = mv.clientX - startX;
    if (!_canvasDragged && Math.abs(dxPix) < 3) return;
    _canvasDragged = true;
    var dxSec = (dxPix / rect.width) * previewWindow.len;
    previewWindow.start = clampNum(startWinStart - dxSec, 0, Math.max(0, duration - previewWindow.len));
    updateZoomBar();
    scheduleDragRedraw();
  }

  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (_canvasDragged) redrawPreview();
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

async function onCanvasClick(evt) {
  if (_canvasDragged) { _canvasDragged = false; return; }
  if (!analysis || !previewWindow) return;
  var canvas = evt.currentTarget;
  var rect = canvas.getBoundingClientRect();
  if (!rect || !rect.width) return;
  var xFrac = clampNum((evt.clientX - rect.left) / rect.width, 0, 1);
  var relSec = previewWindow.start + xFrac * previewWindow.len;
  if (rangeArm)   { setRangeBoundary(rangeArm, relSec); return; }
  if (anchorArmed) { setAnchor(relSec); return; }
  await seekTo(relSec);
}

async function seekTo(relSec) {
  if (!analysis) return;
  var clamped = clampNum(relSec, 0, analysis.duration);

  // In-panel audio path: reposition the panel's own playback and keep Premiere's
  // playhead loosely in sync too (a move, not a play, so no double audio).
  var ctx = (analysis.waveform && analysis.waveform.samples) ? getAudioContext() : null;
  if (ctx) {
    previewPlayheadRel = clamped;
    if (webAudio.playing) await startInPanelPlayback(ctx, clamped);
    updatePlayheadOverlay();
    if (analysis.sequence) {
      try { await setSequencePosition(analysis.sequence, analysis.clipInfo.start + clamped); } catch (_) {}
    }
    return;
  }

  if (!analysis.sequence) return;
  var moved = await setSequencePosition(analysis.sequence, analysis.clipInfo.start + clamped);
  if (moved) {
    previewPlayheadRel = clamped;
    updatePlayheadOverlay();
  } else {
    log('Could not move Premiere\'s playhead — no working position-set API found.', 'error');
  }
}

async function togglePlayback() {
  if (!analysis) return;
  var playBtn = document.getElementById('playBtn');

  // Pause whichever path we started.
  if (webAudio.playing) {
    var ctx2 = getAudioContext();
    var elapsed = ctx2 ? inPanelPositionSec(ctx2) : (previewPlayheadRel || 0);
    stopInPanelSource();
    stopPlayheadPoll();
    previewPlayheadRel = clampNum(elapsed, 0, analysis.duration);
    playBtn.textContent = '▶ Play';
    updatePlayheadOverlay();
    return;
  }
  if (panelStartedPlayback) {
    if (analysis.sequence) await tryPauseSequencePlayback(analysis.sequence);
    panelStartedPlayback = false;
    playBtn.textContent = '▶ Play';
    return;
  }

  var jumpRel = previewPlayheadRel != null ? previewPlayheadRel : previewWindow.start;

  // Preferred: real sound from the panel via Web Audio, when we have decoded
  // samples and this UXP host exposes AudioContext. Falls through to the Premiere
  // transport if either is missing or the source won't start.
  var ctx = (analysis.waveform && analysis.waveform.samples) ? getAudioContext() : null;
  if (ctx) {
    playBtn.disabled = true;
    var ok = await startInPanelPlayback(ctx, jumpRel);
    playBtn.disabled = false;
    if (ok) {
      previewPlayheadRel = jumpRel;
      playBtn.textContent = '⏸ Pause';
      startInPanelPoll(ctx);
      log('Playing audio in the panel from ' + jumpRel.toFixed(1) + 's.', 'info');
      return;
    }
  }

  if (!analysis.sequence) { log('Nothing to play — no audio decoded and no sequence.', 'error'); return; }
  var sequence = analysis.sequence;
  playBtn.disabled = true;
  var moved = await setSequencePosition(sequence, analysis.clipInfo.start + jumpRel);
  if (!moved) {
    log('Could not move Premiere\'s playhead — no working position-set API found.', 'error');
    playBtn.disabled = false;
    return;
  }
  previewPlayheadRel = jumpRel;
  updatePlayheadOverlay();

  // The follow loop (always running) mirrors the moving playhead onto the preview
  // whether or not we could script the transport start.
  var started = await tryStartSequencePlayback(sequence);
  playBtn.disabled = false;
  if (started) {
    panelStartedPlayback = true;
    playBtn.textContent = '⏸ Pause';
    log('Playing in Premiere from ' + jumpRel.toFixed(1) + 's — preview playhead will follow.', 'info');
  } else {
    log('Continuous playback isn\'t scriptable in this Premiere version — moved the playhead to ' +
      jumpRel.toFixed(1) + 's. Press play in Premiere and the preview playhead will follow along.', 'info');
  }
}

function stopPlayheadPoll() {
  if (playheadPollHandle != null) { cafFn(playheadPollHandle); playheadPollHandle = null; }
}

// Mirrors Premiere's sequence playhead onto the preview so the playhead tracks
// playback however it started — the panel's Play button OR play/scrub in Premiere
// directly (which the panel gets no event for, hence polling).
//
// Every poll is a round trip across the UXP↔Premiere scripting bridge that lands
// on Premiere's own thread, so polling fast during playback competes with the
// very playback it's trying to track — which is what made both Premiere's
// transport and this playhead stutter. The loop therefore asks as rarely as it
// can and fills the gaps locally: each poll measures how fast sequence time is
// advancing per wall-clock second, and between polls the playhead is dead-reckoned
// from that rate on a rAF ticker that never touches the bridge. The result is a
// smoother playhead than the old fast poll produced, at a fraction of the traffic.
//
// It also stays quiet when it has nothing to learn: the bridge is skipped entirely
// while in-panel Web Audio owns the playhead (that path drives itself from the
// audio clock) and while the panel is hidden, and the idle heartbeat backs off
// toward FOLLOW_MAX_MS so a panel left open on a still timeline costs almost
// nothing. Any movement snaps it back to the responsive cadence.
var FOLLOW_PLAYING_MS = 500;  // resync while sequence time is advancing
var FOLLOW_IDLE_MS    = 750;  // first heartbeat once movement stops
var FOLLOW_MAX_MS     = 2000; // heartbeat floor after a long idle stretch
var FOLLOW_HIDDEN_MS  = 2000; // barely ticking while the panel isn't visible
var FOLLOW_QUIET_MS   = 2000; // in-panel audio owns the playhead; just watch for it ending
var FOLLOW_MAX_ERRORS = 5;    // give up after this many consecutive bridge failures
var FOLLOW_STALL_POLLS = 4;   // motionless polls before assuming Premiere stopped on its own

// Hard cap on how far ahead of the last poll dead reckoning will predict, so a
// playback stop that lands between polls can only ever overshoot by this much
// before the next poll corrects it.
var FOLLOW_PREDICT_CAP_SEC = 1.0;

function stopFollowRaf() {
  if (_followRafHandle != null) { cafFn(_followRafHandle); _followRafHandle = null; }
}

function startPremiereFollow() {
  var gen = ++_followGen;
  if (!analysis || !analysis.sequence) return;
  _lastFollowTicks = null;
  _followRate = 0;
  _followWasMoving = false;
  _followAnchorWall = 0;
  _followFailures = 0;
  var seq = analysis.sequence;
  var idleMs = FOLLOW_IDLE_MS;
  var stalls = 0;

  // Paints the dead-reckoned playhead between polls. Runs only while the playhead
  // is actually advancing — at rate 0 it retires itself rather than spinning.
  function predictTick() {
    if (gen !== _followGen) { _followRafHandle = null; return; }
    if (_followRate <= 0 || !analysis || !previewWindow) { _followRafHandle = null; return; }
    var ahead = Math.min((Date.now() - _followAnchorWall) / 1000, FOLLOW_PREDICT_CAP_SEC);
    var rel = clampNum(_followAnchorRel + ahead * _followRate, 0, analysis.duration);
    showFollowPosition(rel);
    _followRafHandle = rafFn(predictTick);
  }

  function startPredicting() {
    if (_followRafHandle == null && _followRate > 0) _followRafHandle = rafFn(predictTick);
  }

  function showFollowPosition(relSec) {
    if (relSec >= 0 && relSec <= analysis.duration) {
      previewPlayheadRel = relSec;
      if (followPlayheadIntoView(relSec)) redrawPreview(); else updatePlayheadOverlay();
    } else {
      previewPlayheadRel = null;
      updatePlayheadOverlay();
    }
  }

  (function loop() {
    if (gen !== _followGen) return;

    // Nothing to learn from the bridge in these two states, so don't pay for it.
    // Clearing the anchor makes the first poll after either gap a fresh baseline,
    // so a long dormant stretch can't be read as a burst of playback.
    if (typeof document !== 'undefined' && document.hidden) {
      stopFollowRaf(); _followRate = 0; _followWasMoving = false; _followAnchorWall = 0;
      setTimeout(loop, FOLLOW_HIDDEN_MS); return;
    }
    if (webAudio.playing) {
      stopFollowRaf(); _followRate = 0; _followWasMoving = false; _followAnchorWall = 0;
      setTimeout(loop, FOLLOW_QUIET_MS); return;
    }

    seq.getPlayerPosition().then(function (pos) {
      if (gen !== _followGen) return;
      _followFailures = 0;

      var ticks = pos ? String(pos.ticks) : null;
      var moved = ticks !== _lastFollowTicks;
      _lastFollowTicks = ticks;

      var nowWall = Date.now();
      var relSec = pos ? ticksToSeconds(pos.ticks) - analysis.clipInfo.start : null;

      if (relSec == null) {
        _followRate = 0; _followWasMoving = false; stopFollowRaf();
        setTimeout(loop, idleMs); return;
      }

      // Derive the playback rate for the next stretch of dead reckoning. A rate is
      // only trusted when the previous interval was also moving — the first interval
      // after a start includes however long the playhead sat still before it began,
      // which would read as a fraction of real speed. Backwards or absent movement
      // (a scrub, a stop) predicts nothing and just snaps to the reported position.
      var dtWall = _followAnchorWall ? (nowWall - _followAnchorWall) / 1000 : 0;
      var dtSeq  = relSec - _followAnchorRel;
      var rate = dtWall > 0.05 ? dtSeq / dtWall : 0;
      if (!moved || dtSeq < 0 || dtWall <= 0.05) _followRate = 0;
      else if (rate > 4)                         _followRate = 0; // faster than any playback — a scrub or a seek
      else if (!_followWasMoving)                _followRate = 1;
      else                                       _followRate = rate;

      _followWasMoving  = moved;
      _followAnchorRel  = relSec;
      _followAnchorWall = nowWall;

      if (moved) showFollowPosition(relSec);

      if (panelStartedPlayback && relSec > analysis.duration) {
        tryPauseSequencePlayback(seq);
        panelStartedPlayback = false;
        document.getElementById('playBtn').textContent = '▶ Play';
        _followRate = 0;
      }

      if (_followRate > 0) startPredicting(); else stopFollowRaf();

      // Premiere's transport can also be stopped outside the panel (space bar, the
      // program monitor), and nothing tells us — so a playhead that sits still
      // across several polls is the signal. Without this the panel keeps claiming
      // it's playing, its button keeps saying Pause, and the fast cadence never
      // lets up for the rest of the session.
      if (panelStartedPlayback && !moved) {
        if (++stalls >= FOLLOW_STALL_POLLS) {
          panelStartedPlayback = false;
          document.getElementById('playBtn').textContent = '▶ Play';
          stalls = 0;
        }
      } else if (moved) stalls = 0;

      // Watch closely whenever the playhead moved at all — not just when a usable
      // rate came out of it. A backwards seek (scrub back, then play) yields no
      // rate, and treating that as idle used to drop it onto the backed-off
      // heartbeat, so following didn't resume for seconds after playback started.
      var active = moved || _followRate > 0 || panelStartedPlayback;
      if (active) idleMs = FOLLOW_IDLE_MS;
      else        idleMs = Math.min(FOLLOW_MAX_MS, Math.round(idleMs * 1.5));
      setTimeout(loop, active ? FOLLOW_PLAYING_MS : idleMs);
    }).catch(function (e) {
      if (gen !== _followGen) return;
      // A single rejection used to kill following for good. Retry on the slow
      // heartbeat instead, and stand down only if the API is consistently absent.
      stopFollowRaf();
      _followRate = 0; _followWasMoving = false;
      if (++_followFailures >= FOLLOW_MAX_ERRORS) {
        console.log('[BM] playhead follow unavailable — not tracking Premiere:', e && e.message);
        return;
      }
      setTimeout(loop, FOLLOW_MAX_MS);
    });
  })();
}

function stopPremiereFollow() {
  _followGen++;
  stopFollowRaf();
  _followRate = 0;
  _followWasMoving = false;
  _followAnchorWall = 0;
}

// Scrolls the zoom window to follow playback, and returns true only when it
// actually moved the window (so the caller repaints the waveform only then — the
// playhead itself moves via the cheap overlay every tick regardless). The window
// stays put while the playhead sweeps across it and only jumps forward once the
// playhead passes ~85%, resuming from ~30%, so the expensive canvas redraw happens
// roughly once per window-width of playback instead of every frame. Near the
// clip's start/end it clamps in place and the playhead travels to the edge.
function followPlayheadIntoView(relSec) {
  if (!previewWindow || !analysis) return false;
  var len = previewWindow.len;
  var maxStart = Math.max(0, analysis.duration - len);
  if (relSec < previewWindow.start || relSec >= previewWindow.start + len * 0.85) {
    var target = clampNum(relSec - len * 0.3, 0, maxStart);
    if (Math.abs(target - previewWindow.start) > 1e-4) {
      previewWindow.start = target;
      updateZoomBar();
      return true;
    }
  }
  return false;
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

    // Everything's gone now, so the tracked Place batch no longer exists to undo.
    lastPlacement = null;
    document.getElementById('undoBtn').disabled = true;

  } catch (err) {
    log('Error: ' + err.message, 'error');
    console.error('[BM]', err);
  }
}

// Removes only the markers created by the most recent Place Markers run, leaving
// any markers that were already on the clip untouched — a targeted undo rather
// than the blanket Clear Markers on Clip.
async function runUndoPlaceMarkers() {
  if (!lastPlacement || !lastPlacement.markers.length) { log('Nothing to undo.', 'info'); return; }
  try {
    var project = await ppro.Project.getActiveProject();
    if (!project) throw new Error('No active project — open a project first');

    var mc = lastPlacement.mc;
    var batch = lastPlacement.markers;
    var before = await countMarkers(mc);
    log('Undoing ' + batch.length + ' placed markers…', 'info');

    var removed = 0;
    for (var i = 0; i < batch.length; i++) {
      if (await removeClipMarker(project, mc, batch[i])) removed++;
    }
    if (removed === 0) throw new Error('Could not remove the placed markers — they may have already been deleted (see console)');

    var after = await countMarkers(mc);
    log('Undid ' + removed + ' of ' + batch.length + ' placed markers' +
      (before >= 0 && after >= 0 ? ' (' + before + ' → ' + after + ')' : '') + '.', 'success');

    lastPlacement = null;
    document.getElementById('undoBtn').disabled = true;

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
  if (anchorArmed) { rangeArm = null; updateRangeUi(); }
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

// ── Placement range (mark only a section of the clip) ───────────────────────────
//
// analysis.rangeStart / rangeEnd bound where markers are placed, in clip-relative
// seconds; either may be null to mean "clip start" / "clip end", so a one-sided
// range still works. computeMarkerBeats filters to this range, so the preview and
// Place Markers stay identical — the dimmed regions in the waveform are exactly
// the beats that won't be committed.

function toggleRangeArm(which) {
  if (!analysis) return;
  rangeArm = (rangeArm === which) ? null : which;
  if (rangeArm) { anchorArmed = false; updateAnchorUi(); }
  updateRangeUi();
}

function setRangeBoundary(which, relSec) {
  if (!analysis) return;
  var v = clampNum(relSec, 0, analysis.duration);
  if (which === 'in') {
    var hi = analysis.rangeEnd != null ? analysis.rangeEnd : analysis.duration;
    analysis.rangeStart = Math.min(v, hi);
  } else {
    var lo = analysis.rangeStart != null ? analysis.rangeStart : 0;
    analysis.rangeEnd = Math.max(v, lo);
  }
  rangeArm = null;
  document.getElementById('placeBtn').disabled = false;
  updateRangeUi();
  redrawPreview();
  log('Placement ' + (which === 'in' ? 'In' : 'Out') + ' set at ' +
    (which === 'in' ? analysis.rangeStart : analysis.rangeEnd).toFixed(2) + 's.', 'success');
}

function clearRange() {
  rangeArm = null;
  if (!analysis || (analysis.rangeStart == null && analysis.rangeEnd == null)) { updateRangeUi(); return; }
  analysis.rangeStart = null;
  analysis.rangeEnd = null;
  updateRangeUi();
  redrawPreview();
  log('Placement range cleared — markers span the whole clip.', 'info');
}

function updateRangeUi() {
  var inBtn = document.getElementById('rangeInBtn');
  var outBtn = document.getElementById('rangeOutBtn');
  var clearBtn = document.getElementById('rangeClearBtn');
  var info = document.getElementById('rangeInfo');
  if (!inBtn || !outBtn || !clearBtn) return;
  var hasRange = analysis && (analysis.rangeStart != null || analysis.rangeEnd != null);
  inBtn.disabled = !analysis;
  outBtn.disabled = !analysis;
  clearBtn.disabled = !hasRange;
  inBtn.textContent  = rangeArm === 'in'  ? '⟤ Click waveform…' : '⟤ Set In';
  outBtn.textContent = rangeArm === 'out' ? 'Click waveform… ⟥' : 'Set Out ⟥';
  if (rangeArm === 'in')  inBtn.classList.add('armed-range');  else inBtn.classList.remove('armed-range');
  if (rangeArm === 'out') outBtn.classList.add('armed-range'); else outBtn.classList.remove('armed-range');
  if (info) {
    if (rangeArm) {
      info.textContent = 'Click where placement should ' + (rangeArm === 'in' ? 'start' : 'end');
    } else if (hasRange) {
      var lo = analysis.rangeStart != null ? analysis.rangeStart.toFixed(2) + 's' : 'start';
      var hi = analysis.rangeEnd   != null ? analysis.rangeEnd.toFixed(2) + 's'   : 'end';
      info.textContent = 'Marking ' + lo + ' → ' + hi;
    } else {
      info.textContent = '';
    }
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
