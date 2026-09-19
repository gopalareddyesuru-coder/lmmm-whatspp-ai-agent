# LMMM V7.2 — Memory-Safe User-First Stabilization

Fixes:
- TIFF conversion uses lower-memory per-frame JPEG embedding instead of large PNG pages.
- Conversion remains a durable background job; normal WhatsApp use stays available.
- Temporary source pointers/caches are deleted after successful output delivery.
- Expired temporary source metadata is cleaned at startup; in-memory caches are swept every 5 minutes.
- Failed/retryable jobs retain their source reference until success/expiry so recovery remains possible.
- Structured maintenance data, indexed knowledge, audit records and exact identifiers are never removed by temp cleanup.
- Short retrieval phrases such as `Furnace-2 defects` are treated as searches, not automatically saved as new defects.

Render commands remain:
- Build: `npm install && npm run verify:runtime`
- Start: `npm start`


## V7.3 additions
- Access MDB/ACCDB → XLSX: every readable Access table becomes a separate Excel sheet; completion metadata tracks tables/sheets/rows.
- Access worksheets get practical widths and collision-safe sheet names.
- Excel/XLS → CSV: one sheet = one CSV; multiple sheets = ZIP containing one CSV per sheet.
- CSV → XLSX conversion.
- Conversion does not store/index maintenance data unless Store is explicitly chosen.
