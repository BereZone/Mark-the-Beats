# Beat Marker

UXP plugin for Adobe Premiere Pro that detects beats in audio and drops timeline markers automatically.

## Install (sideload)

1. Download and open the **UXP Developer Tool** (available from [Adobe Developer Console](https://developer.adobe.com/developer-distribution/creative-cloud/docs/guides/uxp_guide/uxp-developer-tool/)).
2. In the UXP Developer Tool, click **Add Plugin** and point it at the `manifest.json` in this folder.
3. Click **Load** (or **Load and Watch** for live-reload during development).
4. In Premiere Pro, open the plugin from **Window → Extensions → Beat Marker**.

Ensure **Adobe Media Encoder** is installed — it handles the audio export step.

## Usage

1. Open a sequence in the Premiere timeline.
2. *(Optional)* Select a clip to analyse only that clip's audio; leave nothing selected to analyse the full sequence.
3. Click **Analyze Selected Clip** — this decodes the audio (or reads the manual BPM field)
   and draws a preview: the waveform with a tick at every detected/computed beat position.
   No markers are placed yet.
4. Use the preview toolbar to inspect it closely:
   - The waveform starts zoomed to the first 4 seconds. **Drag the waveform itself**
     to slide the visible window, or use the bar next to the Play button like
     Premiere's timeline zoom bar: drag the middle to pan, drag either rounded end
     handle to zoom in/out, or click the bare track to jump there. The `+`/`−`
     buttons zoom in/out centered on the current view
   - Mouse-wheel zoom isn't available — this UXP host doesn't forward scroll-wheel
     input into the panel at all
   - Click **▶ Play** to hear the clip. Playback happens entirely inside the panel,
     using the audio already decoded for detection — it never drives Premiere's
     transport or moves Premiere's playhead, so auditioning a clip costs Premiere
     nothing. Clicking the waveform seeks that playback
   - **◎ Set Beat 1** then click the downbeat in the waveform to lock the grid's
     phase to it — the grid rebuilds at the current tempo so a beat lands exactly
     there (drawn as a gold flagged line). Use it when the auto-detected grid is a
     hair out of phase with the real downbeat; **Clear anchor** reverts
   - **⟤ Set In** / **Set Out ⟥** then click the waveform to mark only a section
     of the clip — markers are placed only between the In and Out points (either
     is optional: set just In to mark from there to the end, or just Out for the
     start up to there). The excluded stretch is dimmed in the preview; **Clear
     range** goes back to marking the whole clip
5. Adjust settings and watch the preview update live, with no need to re-analyze:
   - **BPM** — leave blank for auto-detect, or type a value; click **Auto** to clear it and
     revert to the detected BPM
   - **Place marker every** — sparser (every Nth beat: 2 = half-time, 4 = bar markers) or
     denser sub-beat subdivisions (½ beat = 8th notes, ¼ beat = 16th notes), aligned to the grid
   - **Offset (ms)** — nudge all markers earlier (negative) or later (positive)
   - **Marker color** — applied to each marker when placed
   - **Marker name prefix** — text before the beat number, e.g. `Beat 1`, `Beat 2`…
6. When the preview looks right, click **Place Markers** to commit clip markers to the
   clip that was analyzed. **Undo Placed Markers** removes just that last batch (leaving
   any pre-existing markers), while **Clear Markers on Clip** removes every marker.

## Known limitations

- Playback is entirely panel-local and never touches Premiere. Sound comes from
  whichever of these the host supports, probed in order and verified rather than
  assumed:
  1. **Web Audio** (`AudioContext`) — sample-accurate and needs no temp file. CEP
     extensions always have it; most UXP builds don't.
  2. **UXP's media element** — UXP's `<audio>` element is inert
     (`document.createElement('audio')` returns a node without even
     `play()`/`pause()`), which is what made in-panel sound look impossible, but its
     `<video>` element is not: Adobe's UXP reference states it "can also play audio
     files". A hidden video element pointed at an audio file is the working route.
     It needs a real file, so the decoded PCM is written back out as a temp WAV.
     **Reported working on macOS and not on Windows** (Premiere 26.0.2).
  3. **Silent preview** — the playhead still sweeps the waveform against the beat
     grid in real time, without sound.

  Manual-BPM analyses skip the decode step, so there's no PCM to write; they play the
  source file directly instead, offset by the clip's in-point.
- The panel does not follow Premiere's playhead, and Play does not move it. The two
  playheads are independent by design: mirroring them meant polling Premiere across
  the UXP scripting bridge many times a second, which is what previously made
  Premiere's own playback stutter while the panel was open.
- WAV and MP3 clips are read directly — no AME dependency for those formats.
- Other formats (AAC, MOV, etc.) still require Adobe Media Encoder for the transcode-to-WAV step.
- AME must be available to Premiere's encoder bridge; if it isn't running, start it manually first.
- Beat detection is a pure-JS energy-flux detector — works well on music with a steady kick/snare pattern; results on ambient or heavily syncopated tracks may need the offset control to correct phase drift.
- Very short clips (< 2 s) may not yield reliable tempo estimates.
- Tested on macOS; Windows paths in the temp-file logic should work but are less exercised.

## Adjusting detection sensitivity

Open `src/beatDetector.js` and adjust:

- **`threshold = mean + 1.5 * std`** — raise the multiplier (e.g. `2.5`) to suppress false onsets on noisy tracks; lower it for quiet acoustic material.
- **`minGapFrames` / `0.1` (100 ms)** — minimum gap between onsets; raise to prevent double-triggers on transient-heavy material.
- **BPM search range `60–200`** — widen or narrow as needed for very slow/fast music.

See [`docs/development.md`](docs/development.md) for full development setup.
