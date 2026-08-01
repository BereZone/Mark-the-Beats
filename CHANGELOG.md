# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **In-panel audio playback** — when the host exposes Web Audio (`AudioContext`),
  Play now sends the already-decoded PCM straight to the speakers from the panel
  instead of driving Premiere's transport, so you hear the clip without moving the
  timeline. CEP extensions get this for free (full embedded Chromium); UXP's
  `<audio>` element is inert, so this feeds the decoded samples through
  `AudioContext` instead, probed and cached like the other host APIs. If no
  `AudioContext` is available it silently falls back to the Premiere-transport
  behaviour. Seeking/pausing reposition the panel playback directly
- **Placement range** — mark only a section of a clip instead of the whole thing.
  Arm **Set In** / **Set Out** in the preview toolbar and click the waveform to set
  either boundary (either side is optional: In-only marks from there to the end,
  Out-only from the start to there). The excluded stretches are dimmed in the
  preview and **Clear range** reverts to the whole clip. It filters the same
  beats-per-marker generator the preview and Place Markers share, so the dimmed
  beats are exactly the ones that won't be committed
- **Undo Placed Markers** button — removes only the markers created by the most
  recent Place Markers run, leaving any markers that were already on the clip intact
  (unlike Clear Markers on Clip, which removes everything). The batch is tracked by
  the marker handles returned at placement; the button enables after a placement and
  disables once undone or once the clip is cleared
- Sub-beat subdivisions in the "Place marker every" control — **½ beat (8th notes)**
  and **¼ beat (16th notes)** place markers denser than one-per-beat, aligned to the
  beat grid (and to the downbeat anchor when set). The interval is now a
  beats-per-marker value so sparser multiples and denser subdivisions share one
  generator that both the preview and Place Markers draw from, keeping them identical

### Changed
- The preview playhead now follows Premiere's playback continuously, however it was
  started — the panel's Play button **or** pressing play / scrubbing in Premiere
  directly. Previously it only tracked playback the panel itself started, so on
  hosts where the transport isn't scriptable the playhead never moved. A poll mirrors
  the sequence playhead onto the preview; its cadence is adaptive — a slow heartbeat
  when nothing is moving, fast only while the playhead is advancing, and dormant while
  the panel is hidden — so it doesn't burden Premiere by hammering the scripting bridge
  when it's just sitting open, and it only repaints on an actual move
- The preview window now scrolls to follow playback — it stays put while the playhead
  sweeps across it and jumps forward once the playhead passes ~85% (resuming near 30%),
  clamping in place at the clip's start/end. The playhead itself moves smoothly the
  whole time as a CSS overlay, so following no longer repaints the waveform every frame
- Preview toolbar polish: the zoom `+`/`−` buttons are now compact icon buttons; the
  text mini-buttons share a consistent height and no longer wrap; and the zoom bar is
  taller and higher-contrast (so it's easier to see) while taking less horizontal width
- **Drag the waveform to pan** — grab anywhere on the preview and drag to slide the
  visible window (a press without movement still seeks). Makes navigating a zoomed-in
  clip far less fiddly than reaching for the zoom bar every time
- The zoom `+`/`−` buttons now center on the playhead (when there is one), so you can
  zoom straight in on the current position instead of on the middle of the view
- Zoom bar is easier to grab: the thumb now has a minimum on-screen width so it stays
  grabbable even when zoomed far into a long clip (the actual zoom is unchanged — only
  the thumb's drawn width is floored, and its position is clamped so it never overflows
  the bar), and the resize end-caps are restyled as Premiere-like rounded grip handles

### Added
- **In-panel audio actually plays now, via UXP's video element.** UXP's `<audio>`
  element is inert here — `document.createElement('audio')` returns a node without even
  `play()`/`pause()` — which is what made panel sound look impossible and sent playback
  through Premiere's transport in the first place. Its **`<video>` element is not**:
  Adobe's UXP reference states the video element "can also play audio files", and it
  exposes the usual `src`/`currentTime`/`play`/`pause` surface. Play now feeds a hidden
  video element the clip's audio and drives the playhead from that element's own clock.
  It needs a real file rather than in-memory PCM, so the decoded samples are written
  back out as a temp WAV — already sliced to the clip's in/out, so the element's
  `currentTime` is clip-relative time directly. Reported working on macOS and **not on
  Windows** (Premiere 26.0.2), so it stays probed and verified, with Web Audio preferred
  above it where a host has it and the silent preview underneath
- Manual-BPM analyses decode no audio, so they now play the **source file directly**,
  offset by the clip's in-point — they were previously silent with no way to get sound
  short of re-analyzing

### Changed
- **Playback is now entirely in-panel and never touches Premiere.** Play used to drive
  Premiere's sequence transport and then poll `getPlayerPosition` to mirror the sequence
  playhead back onto the preview; every poll was a round trip across the UXP↔Premiere
  scripting bridge onto Premiere's own thread, so auditioning a clip made the panel
  compete with the application it was asking to play. The panel now plays the PCM it
  already decoded during analysis through Web Audio and drives the playhead from a local
  clock. Nothing in the playback path calls into Premiere on any cadence, so an open
  panel costs Premiere nothing whether it's idle, playing, or paused
- **Play and the preview playhead no longer move Premiere's playhead**, and the preview
  no longer follows it. The two are independent by design — keeping them in step is what
  required the polling in the first place. Clicking the waveform seeks the panel's own
  playback only
- **Where a host supports none of the audio routes, Play runs a silent preview** — the
  playhead sweeps the waveform against the beat grid in real time without sound —
  instead of falling back to Premiere's transport. The status line says which case it
  hit rather than silently doing nothing

### Fixed
- **The preview playhead moves smoothly during in-panel playback.** It was reading its
  position straight off the media element every frame, but a media element publishes
  `currentTime` in coarse steps rather than continuously — so the playhead lurched
  forward a few times a second and sat still in between. It now runs off a local clock
  and consults the element's clock four times a second purely to correct drift.
  Corrections are asymmetric, because a stepped clock only ever *under*-reports: the
  element reading behind the playhead is the expected steady state and is ignored,
  while it reading ahead is a real error and is eased in. The tolerance for "behind"
  adapts to the granularity the host actually shows, so a coarse clock can't be
  mistaken for a stall and yanked backwards
- Play at the end of a clip now replays from the start instead of doing nothing
- The preview no longer flashes/reloads during playback. The playhead used to be drawn
  on the canvas, so moving it each tick forced a full waveform repaint, which this
  canvas shows mid-draw as a dark flicker. The playhead is now a CSS overlay that moves
  without touching the canvas, and the waveform is repainted only when the window
  actually scrolls. The canvas backing store is also resized only when its dimensions
  change (it was being reallocated — and cleared — on every redraw)
- `manifest.json` now reports version 0.2.0, matching `package.json`. The 0.2.0 release
  bumped only `package.json`, so Premiere kept showing the plugin as 0.1.0
- **Premiere no longer stutters while the panel is open.** The panel polled Premiere for
  its playhead position ~11×/second during playback — each poll a round trip across the
  UXP↔Premiere scripting bridge onto Premiere's own thread — and kept a slower heartbeat
  going forever after the first analysis. Playback is now panel-local (see Changed) and
  the polling is gone entirely, so the panel makes no periodic calls into Premiere at all
- **The panel no longer holds the audio output device open for the whole session.** The
  `AudioContext` was created on the first waveform click and left running forever after,
  contending with Premiere's own audio output even when the panel was silent. It's now
  suspended whenever nothing is playing and resumed on play

## [0.2.0] - 2026-07-22

### Added
- **Downbeat anchoring** — arm **Set Beat 1**, then click the downbeat in the
  waveform to lock the grid's phase to it. The whole grid is rebuilt at the current
  tempo so a beat lands exactly on the anchor (filling backward to the clip start as
  well as forward), overriding the detector's (or a manual grid's) phase with the
  beat the user pointed at. The anchor is drawn as a distinct gold flagged line,
  survives BPM changes (re-phased at the new tempo), and **Clear anchor** reverts to
  the detected/computed phase. Fixes the common case of the auto-detected grid being
  a hair out of phase with the actual downbeat
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
- Auto-detected beats on MP3 clips landed a small, consistent amount (roughly a
  frame, tens of milliseconds) after where they should — MP3 encoders (LAME and
  LAME-compatible encoders like ffmpeg's libmp3lame) pad the front of the
  compressed stream with priming samples for the MDCT filterbank, and often the
  tail too, typically ~500-1150 samples each way. The vendored decoder didn't
  strip these, so decoded sample 0 didn't actually correspond to the true start
  of the audio, silently shifting every detected beat later by that amount. This
  is the standard mechanism any gapless-aware MP3 player compensates for.
  `mp3Parser.js` now reads the delay/padding fields from the file's Xing/LAME
  tag (scanned directly for the tag bytes rather than computed from frame-header
  offsets, to be robust to getting MPEG-version/channel-mode offset math wrong)
  and trims the decoded PCM accordingly before beat detection ever sees it.
  Verified the tag-parsing logic — flag-based optional-field skipping, the
  bit-packed delay/padding extraction, and correctly returning no trim when no
  tag is present — against constructed test buffers covering several flag
  combinations; the underlying premise (encoder delay causing exactly this kind
  of drift) is well-established for MP3 generally, but hasn't been confirmed
  against a real affected file
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

[Unreleased]: https://github.com/YOUR_ORG/beat-marker/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/YOUR_ORG/beat-marker/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/YOUR_ORG/beat-marker/releases/tag/v0.1.0
