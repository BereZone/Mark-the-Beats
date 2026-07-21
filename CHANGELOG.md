# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Zoomable/pannable preview: the waveform no longer compresses the whole clip into
  one narrow view — it defaults to a 4-second zoomed-in window at the clip start,
  with a Premiere-style zoom bar (drag the thumb to pan, drag either edge to
  resize/zoom, click the bare track to jump there — edges now have visibly distinct
  end-cap styling rather than blending into the bar) plus `+`/`−` buttons for
  click-based zoom centered on the current window. Mouse-wheel zoom was attempted
  but dropped: confirmed live that this UXP host never dispatches `wheel` events
  into the panel DOM at all (click/mousedown are forwarded, wheel isn't) — a gap
  in the native embedding no JS-side event binding can work around
- Playback drives **Premiere's own sequence transport** instead of an in-panel
  `<audio>` element — confirmed on this UXP build that `document.createElement('audio')`
  returns an inert node without even `play()`/`pause()`, so there's no real audio
  API to build on inside the panel. Play/seek now move and (where scriptable) start
  the actual sequence playhead via the `premierepro` API, so sound comes from
  Premiere itself. Since nothing in this codebase had touched playback before and
  the exact method names aren't documented, position-set and play/pause are each
  probed across a few candidate method names and verified — position-set by reading
  the position back, play by checking whether the playhead genuinely advances
  afterward (not just "no exception thrown," which proved to be a false
  signal with the `<audio>` element too) — mirroring how marker creation/color/removal
  are handled elsewhere in this file. If no candidate advances the playhead, Play
  falls back to only moving Premiere's playhead to the clicked/previewed position
  rather than claiming continuous playback works. A local playhead line tracks the
  polled position on the waveform, with the zoom window following it during playback
- Split the single "Detect Beats" action into an **Analyze → preview → Place Markers**
  workflow: **Analyze Selected Clip** decodes/detects (or reads the manual BPM) and
  draws a canvas preview (waveform + beat-position ticks) without touching the
  timeline; **Place Markers** commits the previewed grid to clip markers. Changing
  BPM, marker interval, offset, or color after analyzing recomputes and redraws the
  whole grid live, with no re-decode needed for interval/offset/color changes and no
  re-detection needed for BPM edits (regridded from the cached clip duration; clearing
  back to Auto restores the cached auto-detected grid without re-analyzing)
- Manual BPM input — enter a BPM to place markers on a fixed grid from the clip's
  in-point, skipping audio loading and beat detection entirely; leave blank to auto-detect
- "Auto" button next to the BPM field to reliably clear it back to auto-detect mode
  (clearing a number input by hand isn't always reliable), and the "Place marker every"
  dropdown's default option is now explicitly labeled "Auto (every beat)"
- Marker interval options for non-4/4 time signatures — every 3rd, 5th, 6th, 7th, 9th,
  12th, and 16th beat (3/4, 5/4, 6/8, 7/8, 9/8, 12/8, and multi-bar 4/4 groupings)
- "Clear Markers on Clip" button — removes all clip markers from the selected clip,
  with runtime probing of removal APIs and count verification per marker
- Marker color selection (Green, Red, Purple, Orange, Yellow, White, Blue, Cyan, or
  Default) applied to each placed marker; falls back to default color with a warning
  if the color API is unavailable
- Native MP3 decoding (`mp3Parser.js`, vendoring the dependency-free `js-mp3` decoder
  under `vendor/js-mp3/`) — MP3 clips are read and decoded directly, skipping the AME
  transcode step entirely, so detection is fast and works without Adobe Media Encoder
- Beat markers are now placed as **clip markers on the source audio clip** rather than
  sequence markers; they appear directly on the clip in the timeline and travel with the source
- Marker placement is self-verifying: marker count on the clip is checked before and after
  each commit, and the working `createAddMarkerAction` signature is probed at runtime
  (`name, "Comment", TickTime` confirmed) rather than trusting silent success
- `TickTime` values are built through verified static factories (`createWithTicks` /
  `createWithSeconds`) with the value read back after construction — the bare constructor
  silently produces zero-valued instances

### Changed
- Marker positions are now computed in **source time** (`sourceInPoint + beatOffset`) rather than
  sequence time, which is required for clip/source markers on the ProjectItem
- Beat detection now works end-to-end for non-WAV sources (MP3, AAC, etc.) using
  Premiere Pro's internal encoder (`EXPORT_QUEUE_TO_APP`) with 5-minute polling timeout
- WAV parser now handles streaming-write files where the data chunk size field is
  zero (AME and PPro internal encoder write size=0 during encode and may not update it)
- Fixed URL encoding in `openFileByPath` so paths containing spaces are correctly
  resolved via the UXP local filesystem

### Fixed
- Dragging the zoom bar was glitchy and unresponsive: a mousedown on an edge handle
  bubbled up to the parent thumb's own listener too, starting a second drag session
  (pan) simultaneously with the resize drag — both `mousemove` handlers then fought
  over `previewWindow` on every tick. Fixed with `stopPropagation()` in the drag
  starter. Also throttled the (expensive, full-waveform-rescan) redraw during a drag
  to once per animation frame instead of once per `mousemove` — the zoom bar's own
  thumb position still updates immediately every move since that's cheap CSS-only
- The preview canvas rendered as a solid fill instead of a waveform — UXP's canvas
  doesn't reliably keep `moveTo`-separated subpaths disjoint, so a single path with
  one 2-point segment per pixel column rendered as one filled blob rather than
  independent bars. Waveform bars and beat ticks are now drawn with one `fillRect`
  per column/tick instead, which has no path/subpath ambiguity
- The preview canvas crashed on every redraw with `ctx.setTransform is not a function`
  — UXP's canvas 2D context doesn't implement `setTransform`. High-DPI scaling now
  uses a guarded `ctx.scale()` (called fresh after resizing the backing store, since
  that reset already returns the transform to identity) and falls back to a 1x
  (CSS-pixel) backing store if `scale` itself isn't available either
- All `require()` calls in `mp3Parser.js` and the vendored `vendor/js-mp3/` decoder now
  use explicit `.js` extensions, matching the rest of the codebase — the omitted
  extensions relied on Node-style directory/index resolution that UXP's `require`
  doesn't guarantee, which threw at load time and crashed the entire panel (not just
  MP3 detection), since the failing `require` sat above the `DOMContentLoaded` handler
- `npm run validate` referenced a stale `src/` path that no longer exists; now points
  at the actual module locations and also validates `mp3Parser.js`

## [0.1.0] - 2026-07-16

### Added
- Initial UXP plugin panel for Adobe Premiere Pro
- Pure-JS beat detection using short-time energy flux and autocorrelation tempo estimation
- WAV file parser for uncompressed PCM audio (8/16/24/32-bit, mono/stereo)
- Audio export via Premiere Pro evalScript AME bridge
- "Every Nth beat" control (1, 2, 4, 8)
- Millisecond offset control for nudging markers earlier/later
- Marker name prefix configuration
- Status/log area showing detected BPM and marker count
- Automatic cleanup of temporary WAV files

[Unreleased]: https://github.com/YOUR_ORG/beat-marker/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/YOUR_ORG/beat-marker/releases/tag/v0.1.0
