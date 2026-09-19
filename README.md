# LMMM AI Maintenance Agent V6.3 — Verified Converter Runtime

This build fixes the deployment gap found in V6.2: the app.js change was live while converter packages were absent from the deployed repository/runtime.

## IMPORTANT deployment rule
Commit/upload the **whole contents of this ZIP**, not app.js alone. In particular, `package.json`, `render.yaml`, `scripts/verify-runtime.js`, and `app.js` must all be in the repository. If only app.js is updated, TIFF→PDF and Access→Excel cannot become available.

## Render settings
Build Command: `npm install && npm run verify:runtime`
Start Command: `npm start`

The build now fails early unless all four runtime libraries can actually import: `sharp`, `pdf-lib`, `mdb-reader`, `xlsx`. This prevents a green deploy with unusable converters.

After deployment open `/health`. Required:
- `converters.tiff_to_pdf: true`
- `converters.access_to_excel: true`
- `converter_errors: {}`

## Conversion behavior
- TIFF/TIF → PDF: preserves frame order; conversion path is separate from AI indexing.
- MDB/ACCDB → XLSX: each Access table becomes an Excel worksheet where possible.
- Conversion failure must not take the maintenance bot offline.

## Recovery
`RETRY UP-xx` and `RESUME UP-xx` remain available for ingestion recovery.

## Tested locally in artifact build
- JavaScript syntax check (`node --check app.js`)
- JSON validity (`package.json`)
- ZIP integrity

Note: this artifact environment cannot reproduce Render's Linux npm install, so the deploy-time `verify:runtime` gate is intentionally included. It is the authoritative check that native/runtime packages loaded on Render.
