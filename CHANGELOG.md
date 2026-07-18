# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
