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
   - The waveform starts zoomed to the first 4 seconds. The bar next to the Play button
     works like Premiere's timeline zoom bar: drag the middle to pan, drag either edge
     (the brighter end caps) to zoom in/out, or click the bare track to jump there.
     The `+`/`−` buttons zoom in/out centered on the current view
   - Mouse-wheel zoom isn't available — this UXP host doesn't forward scroll-wheel
     input into the panel at all
   - Click anywhere on the waveform, or click **▶ Play**, to move Premiere's own
     playhead there — sound comes from Premiere itself, not the panel. Whether
     Premiere can be told to start continuous playback from a script depends on
     the Premiere version; if it can't, Play still jumps the playhead to that
     position instead — see Known limitations
   - **◎ Set Beat 1** then click the downbeat in the waveform to lock the grid's
     phase to it — the grid rebuilds at the current tempo so a beat lands exactly
     there (drawn as a gold flagged line). Use it when the auto-detected grid is a
     hair out of phase with the real downbeat; **Clear anchor** reverts
5. Adjust settings and watch the preview update live, with no need to re-analyze:
   - **BPM** — leave blank for auto-detect, or type a value; click **Auto** to clear it and
     revert to the detected BPM
   - **Place marker every** — sparser (every Nth beat: 2 = half-time, 4 = bar markers) or
     denser sub-beat subdivisions (½ beat = 8th notes, ¼ beat = 16th notes), aligned to the grid
   - **Offset (ms)** — nudge all markers earlier (negative) or later (positive)
   - **Marker color** — applied to each marker when placed
   - **Marker name prefix** — text before the beat number, e.g. `Beat 1`, `Beat 2`…
6. When the preview looks right, click **Place Markers** to commit clip markers to the
   clip that was analyzed.

## Known limitations

- Playback moves Premiere's own sequence playhead rather than playing audio inside
  the panel — UXP's webview here has no functional `<audio>` element at all
  (`document.createElement('audio')` returns a node without even `play()`/`pause()`).
  Whether continuous playback can be *started* from a script is unconfirmed and
  depends on the Premiere version — a few candidate API calls are tried and verified
  by checking whether the playhead actually advances; if none work, Play still moves
  Premiere's playhead to the clicked/previewed position (a scrub, not a full
  transport-controlled play) rather than claiming playback started.
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
