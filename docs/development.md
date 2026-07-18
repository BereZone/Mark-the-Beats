# Development Guide

## Prerequisites

- Adobe Premiere Pro 2024 or later (UXP support required)
- Adobe Media Encoder (same version as Premiere)
- [UXP Developer Tool](https://developer.adobe.com/developer-distribution/creative-cloud/docs/guides/uxp_guide/uxp-developer-tool/) installed
- Node.js ≥ 18 (for the `npm run validate` helper and future build steps)

## Loading the plugin for development

1. Open **UXP Developer Tool**.
2. Click **Add Plugin → Select manifest file** and choose `manifest.json` in the project root.
3. Click **Load and Watch** — UXP Developer Tool will reload the plugin whenever source files change.
4. In Premiere Pro: **Window → Extensions → Beat Marker**.

The panel opens as a docked panel. You can undock it for easier access during development.

## File layout

```
Beat Marker/
├── manifest.json          UXP plugin manifest
├── package.json
├── src/
│   ├── index.html         Panel UI entry point
│   ├── styles.css
│   ├── main.js            Plugin orchestration (export → detect → mark)
│   ├── beatDetector.js    Pure-JS beat detection algorithm
│   └── wavParser.js       WAV PCM parser
└── docs/
```

## Testing the beat detector in isolation

The `beatDetector.js` and `wavParser.js` modules use ES module syntax and have no UXP dependencies — you can run them in a browser console or with Node.js + `--experimental-vm-modules` for quick iteration.

```bash
# Validate that modules parse without errors
npm run validate
```

For end-to-end testing inside Premiere:

1. Import a music track with a clear, steady beat (e.g. 120 BPM electronic/pop).
2. Place it on the timeline and run the plugin.
3. Check that markers land close to the drum hits — zoom in on the timeline to verify.
4. Test with a second sequence at a different frame rate (e.g. 25 fps vs 29.97 fps) and confirm markers land at the same audio positions.

## Debugging

- The UXP Developer Tool shows a **Debugger** button — attach Chrome DevTools to the panel for `console.log` output and breakpoints.
- `evalScript` errors surface in the status log; ExtendScript exceptions include a stack trace in their `.toString()`.
- If markers land at wrong positions, check `TICKS_PER_SECOND` in `main.js` against `app.project.activeSequence.timebase` in the ExtendScript console.

## Known API uncertainties

The UXP Premiere Pro marker and encoder APIs are evolving. If the plugin fails:

1. **Marker creation**: open `main.js → createSequenceMarker()` and check which branch executes. You may need to inspect `sequence` in the DevTools console to see the actual method names.
2. **Encoder/export**: the `evalScript` path uses `app.encoder.encodeSequence()` (ExtendScript AME API). If AME is not installed, you'll see "Encoder not available". Alternatively, you can manually export audio as WAV and drop the file into the status area — future versions may support drag-in.

## Releasing

See [docs/releasing.md](releasing.md) (if present) for version bump and tag instructions.
