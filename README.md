# LMMM V7.4 — Universal AI Search

Base: V7.3.1 Access All Tables Real File Fix.

## Universal Search
- Searches structured maintenance event history before reference/manual knowledge.
- Generic asset terms such as pump, gearbox, coupling, motor, bearing, valve, pipe, stand and cylinder are ambiguity-safe: multiple stored matches produce a numbered WhatsApp choice instead of guessing.
- A selected equipment is retained as user search context for follow-ups such as `history`, `drawing`, `spares`, `defects`, `jobs`, `vibration`, `PM`, `shutdown`.
- Exact/unique equipment match is used directly.
- Confirmed alias table foundation is included (`search_aliases`) without automatically learning unsafe generic aliases.
- Existing search-vs-save safety remains in place.
- Existing indexed manuals/drawings/reference knowledge remain the fallback knowledge source.
- Department scope foundation is set to LMMM Department Code 35 in search state/aliases for future plant-wide expansion.

## Existing functionality preserved
- Access -> Excel conversion and all-table verification.
- Excel/CSV conversion support from V7.3 series.
- TIFF background conversion, durable jobs, source isolation and memory-safe processing from prior versions.
- Build: `npm install && npm run verify:runtime`
- Start: `npm start`

## First acceptance tests
1. `pump` — if several stored pump equipment names exist, numbered choices must appear.
2. Select a number, then send `history` — selected equipment context must be retained.
3. `gearbox`, `coupling`, `stand`, `cylinder` — never guess when multiple candidates exist.
4. `Furnace 2 defects` — must retrieve, never create a defect record.
5. `recup` / typo or alias — indexed reference search remains available; aliases can later be explicitly confirmed/learned.
6. `drawing`, `spares`, `vibration`, `shutdown jobs` after selecting equipment — should search in selected equipment context where stored data exists.

Important: the bot can only return equipment/history/manual information already stored/indexed. Missing LMMM source data is not invented.
