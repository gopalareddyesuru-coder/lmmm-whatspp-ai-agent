# LMMM Dept-35 Authorised Big Master — GitHub Test Build

Build: 2026-09-21

## Files
- `master_core_records.json` — authoritative consolidated master payload.
- `unified_retrieval_records.json` — flat retrieval/search payload for the bot.
- `lmmm_big_master_manifest.json` — counts, build metadata and locked bot rules.

## Current counts
- Equipment: 798
- SAP sub-equipment raw consolidated rows: 2056
- Parts/spares source rows: 15481
- Defects: 2301
- Maintenance history: 2467
- Unified retrieval records: 23145

## Important
The latest clean SAP deduplicated target is 2,023 rows; this GitHub test payload deliberately preserves all 2,056 raw consolidated SAP rows so no source row is silently lost. Dedup/mapping must be applied as a governed layer.

Exact ECS vibration and several WBF condition-monitoring numerical tables remain marked pending; no values were invented.
AI manpower/time values must be stored separately as planning estimates, never as historical actuals.
