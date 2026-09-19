# LMMM AI Maintenance Agent V7.0 — Controlled File Intake

Production-safety release focused on trustworthy maintenance data capture.

## File intake
Document upload alone does **not** start AI indexing or permanent storage. The bot presents actions: Read/Analyse, Store, Read+Store, and for TIFF/Access, Convert or Store+Convert. Conversion-only does not pollute maintenance knowledge/history.

## Data integrity
Actual event ingestion retains equipment/date/shift/submitting employee and source audit rules. Reference manuals/drawings remain separate searchable knowledge. Ambiguous event data is held for review; identifiers are never guessed.

## TIFF
Large/multi-frame TIFF conversion decodes one frame at a time, preserves frame order, uses a controlled high pixel safety ceiling, and downsizes only the conversion raster before PDF embedding to avoid Sharp aggregate-pixel failures. AI source data remains the original upload.

## Isolation
Latest convertible source is per employee. Background completions keep immutable source context and older jobs are labelled as earlier uploads.

## Render
Build: `npm install && npm run verify:runtime`
Start: `npm start`

After deploy, `/health` must show TIFF→PDF and Access→Excel true with no converter errors.
