# LMMM Dept-35 AI Maintenance — V17 FINAL

## GitHub/iPhone standard
Every JSON in this package is below 20 MiB. Large JSONs were split record-by-record; they were not summarized to reduce size. `chunk_index_v17.json` records the source file, SHA-256 and ordered chunks.

## Architecture
Plant → Department 35 → Area → Sub-area → System/Utility → Equipment → Sub-equipment → Assembly/Component → Part/SAP → Drawing/Manual → Event.

The package retains the existing source-backed data plus pre-created schemas for the main and supporting modules. Empty schemas remain ready for future records.

## Future WhatsApp data
WhatsApp → approved-user check → voice/photo/document extraction → classify → identify area/equipment/sub-equipment → validate event date/time/shift → save to the correct PostgreSQL module → create junction links → update unified event timeline/search index → immediate retrieval.

Defects link to Jobs; Jobs can link Spares, Tools, Drawings, Manuals, SMP/SOP, Permits and Isolation; Shutdown links Jobs/Permits/LOTO; Attendance and Manpower can link Job/Shutdown; Breakdown/Delay can link Production impact; CBM/Inspection links Equipment and subsequent Defect/Job.

## Data integrity
Exact Equipment/SAP/Material/CAT/Drawing/Part identifiers are never guessed. Server entry timestamp and submitter are separate from event date/time/shift. Ambiguous equipment or date requires clarification. Empty modules return zero/data-not-available rather than borrowing unrelated data.

## Known extraction boundary
Legacy XLS/ACCDB/MDB and scan-only PDF/TIFF/image sources that were not exactly machine-extracted remain preserved/pending and must not be represented as validated structured values. The standalone original V11 ZIP is not available in the active source set, so byte-for-byte V11 certification is not claimed.

## Runtime
GitHub JSON = versioned reference/import package.
PostgreSQL = live operational source of truth.
