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
