# LMMM AI Maintenance Agent V7.0.1 — Stabilized Controlled File Intake

This build is a stabilization pass over V7.0.

## Fixes in this build
- Fixes WhatsApp webhook crash: `TypeError: Assignment to constant variable` in `processMessage`.
- TIFF/Access conversion actions remain bound to the latest uploaded file for that approved employee.
- Conversion-only stays isolated from AI indexing/permanent maintenance storage.
- Clears the pending file-action state after a successful conversion, preventing a later command from acting on stale UI state.
- Large engineering TIFF conversion disables Sharp's aggregate input-pixel safety ceiling and still processes one frame at a time.
- Each TIFF frame is downscaled only for the generated PDF when required, preserving aspect ratio and frame order; the original source is not rewritten.
- Existing source-isolation/upload-session behavior is retained so an older ingestion completion is labelled as an earlier upload instead of masquerading as the current source.
- Existing equipment/date/employee audit, exact identifier preservation, RETRY/RESUME, role controls and reference-vs-event routing are preserved.

## Render
Build command:
`npm install && npm run verify:runtime`

Start command:
`npm start`

Upload/commit the complete ZIP contents to the repository root, including the `scripts` folder.

After deploy, `/health` should report both converter flags as `true` with an empty `converter_errors` object.
