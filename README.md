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
3. Adjust settings in the panel:
   - **Place marker every** — use every Nth beat (good for sparser edits: 2 = half-time, 4 = bar markers)
   - **Offset (ms)** — nudge all markers earlier (negative) or later (positive)
   - **Marker name prefix** — text before the beat number, e.g. `Beat 1`, `Beat 2`…
4. Click **Detect Beats on Selected Clip**.
5. Watch the status log — when done, red markers appear on the sequence timeline.

## Known limitations

- Requires Adobe Media Encoder (AME) to be installed for audio export.
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
