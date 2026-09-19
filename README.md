# LMMM AI Maintenance Agent V6.5 — Source-Isolated Ingestion

## Fixes in this build
- Every upload gets an immutable per-employee upload session.
- Background completion from an older upload is explicitly labelled `Earlier upload completed` with its source filename.
- A delayed old ingestion cannot replace the latest TIFF/Access conversion source.
- `PDF chey` / `Excel chey` remain bound to the newest compatible upload for that approved employee.
- Existing indexed history is not automatically deleted. Test-data deletion remains a deliberate audited action, not an automatic side effect.
- TIFF multi-frame conversion uses all frames reported by Sharp and preserves frame order.
- Existing per-page ingestion checkpoints, retries, exact source references, audit identity/timestamps, and Render converter verification remain intact.

## Render
Build: `npm install && npm run verify:runtime`
Start: `npm start`

After deploy, `/health` must show `tiff_to_pdf: true`, `access_to_excel: true`, and empty `converter_errors`.

## Production safety rule
Never infer an event date from upload time for historical records. Every stored maintenance event remains bound to its source, equipment mapping, event date/shift when known, approved employee identity, and actual entry timestamp. Ambiguous equipment/date data must be held for clarification rather than guessed.
