var parseWav    = require('./wavParser.js').parseWav;
var parseMp3    = require('./mp3Parser.js').parseMp3;
var detectBeats = require('./beatDetector.js').detectBeats;
var ppro        = require('premierepro');
var uxp         = require('uxp');
var localFs     = uxp.storage.localFileSystem;
var formats     = uxp.storage.formats;

var TICKS_PER_SECOND = 254016000000;

// ── UI wiring ─────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('detectBtn').addEventListener('click', function () {
    var btn = document.getElementById('detectBtn');
    btn.disabled = true;
    runDetection().finally(function () { btn.disabled = false; });
  });
  document.getElementById('autoBpmBtn').addEventListener('click', function () {
    var bpmInput = document.getElementById('manualBpm');
    bpmInput.value = '';
    bpmInput.dispatchEvent(new Event('input', { bubbles: true }));
    bpmInput.dispatchEvent(new Event('change', { bubbles: true }));
  });
  document.getElementById('clearMarkersBtn').addEventListener('click', function () {
    var btn = document.getElementById('clearMarkersBtn');
    btn.disabled = true;
    runClearMarkers().finally(function () { btn.disabled = false; });
  });
  document.getElementById('clearBtn').addEventListener('click', function () {
    document.getElementById('statusLog').innerHTML = '';
  });
});

// ── Main flow ─────────────────────────────────────────────────────────────────

async function runDetection() {
  try {
    var project = await ppro.Project.getActiveProject();
    if (!project) throw new Error('No active project — open a project first');

    var sequence = await project.getActiveSequence();
    if (!sequence) throw new Error('No active sequence — open a sequence in the timeline first');

    log('Locating selected clip…', 'info');
    var clipInfo = await getSelectedClipInfo(sequence);
    if (!clipInfo) throw new Error('No clip selected — click an audio clip in the timeline first');
    log('Clip: ' + clipInfo.start.toFixed(3) + ' s – ' + clipInfo.end.toFixed(3) + ' s', 'info');

    var manualBpm = parseFloat(document.getElementById('manualBpm').value);
    var result;
    if (!isNaN(manualBpm)) {
      if (manualBpm < 1 || manualBpm > 999) throw new Error('BPM must be between 1 and 999');
      result = beatsFromBpm(manualBpm, clipInfo.end - clipInfo.start);
      log('Using manual BPM: ' + result.bpm.toFixed(1), 'info');
    } else {
      var audio = await loadClipAudio(clipInfo);
      log('Audio: ' + audio.sampleRate + ' Hz, ' + (audio.samples.length / audio.sampleRate).toFixed(1) + ' s', 'info');

      log('Detecting beats…', 'info');
      result = detectBeats(audio.samples, audio.sampleRate);
      log('Detected ' + result.bpm.toFixed(1) + ' BPM', 'info');
    }

    var nthBeat    = parseInt(document.getElementById('nthBeat').value, 10) || 1;
    var offsetMs   = parseFloat(document.getElementById('offset').value) || 0;
    var prefix     = document.getElementById('prefix').value.trim() || 'Beat';
    var colorIndex = parseInt(document.getElementById('markerColor').value, 10);
    var offsetSec = offsetMs / 1000;
    var clipStart = clipInfo.start;

    log('Placing markers…', 'info');

    // Clip markers live on the source ProjectItem and use source time, not sequence time.
    // sourceStart is the clip's in-point in source media (0 for un-trimmed clips).
    var trackItem = clipInfo.trackItem;
    var sourceStart = 0;
    try {
      var ip = typeof trackItem.getInPoint === 'function' ? await trackItem.getInPoint() : null;
      if (ip && ip.ticks) sourceStart = ticksToSeconds(ip.ticks);
    } catch (_) {}

    var pi = await trackItem.getProjectItem();
    var clipItem2 = ppro.ClipProjectItem.queryCast(pi) || pi;
    var markersCollection = await ppro.Markers.getMarkers(clipItem2);
    var beforeCount = await countMarkers(markersCollection);
    var count = 0;

    for (var i = 0; i < result.beats.length; i++) {
      if (i % nthBeat !== 0) continue;
      var sourceTimeSec = sourceStart + result.beats[i] + offsetSec;
      if (sourceTimeSec < 0) continue;
      var marker = await createClipMarker(project, sequence, markersCollection, sourceTimeSec, prefix + ' ' + (count + 1));
      count++;
      if (colorIndex >= 0 && marker) await setMarkerColor(project, marker, colorIndex);
    }

    var afterCount = await countMarkers(markersCollection);
    if (beforeCount >= 0 && afterCount >= 0) {
      log('Markers on clip: ' + beforeCount + ' → ' + afterCount, 'info');
    }
    log('Done — placed ' + count + ' markers at ' + result.bpm.toFixed(1) + ' BPM.', 'success');

  } catch (err) {
    log('Error: ' + err.message, 'error');
    console.error('[BM]', err);
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
async function createClipMarker(project, sequence, markersCollection, timeInSeconds, name) {
  if (!_TTCtor) {
    try { _TTCtor = (await sequence.getPlayerPosition()).constructor; } catch(_) {}
  }
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
