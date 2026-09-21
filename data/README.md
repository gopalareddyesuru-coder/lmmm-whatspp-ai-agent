# LMMM Dept-35 AI Maintenance Data Package — V16

## Purpose
GitHub-ready master/reference package for RINL/VSP LMMM Department Code 35 WhatsApp-first AI Maintenance Agent.

## Lineage
V16 carries forward V15. Working lineage: V11 → V12 → V13 → V14 → V15 → V16. The original standalone V11 ZIP is not currently available, so byte-for-byte V11 no-loss certification is not claimed.

## Architecture
Plant → Department → Area → Sub-area → System/Utility → Equipment → Sub-equipment → Assembly/Component → Part/SAP → Drawing/Manual → Maintenance Event.

All main and supporting modules have pre-created blocks. Empty blocks are intentional schemas. Future authorised WhatsApp data can be classified and written to the corresponding PostgreSQL module without redesigning the database.

## Main modules
Log Book; Breakdown/Delay; Defects; Jobs/Work Orders; PM; Inspection & Condition Monitoring; CBM/Vibration; Equipment Master; SAP Sub-equipment; Equipment History; Spares; Drawings/Documents; SMP; SOP; Troubleshooting; RCM/Reliability; Shutdown; Employee Attendance; Contract Worker Attendance; Manpower/Labour.

Supporting blocks include Production, Tools & Tackles, Formats/Permits, Job Intelligence, Motor/Drive Mapping, Isolation/LOTO, Measurements, Pipe Thickness, Door Loads, Wheel Diameters, Skid Surveys, Hydraulic/Pneumatic/Crane History, Manual Knowledge, Parts Drawings, Source Registry, Attachments, Search Aliases, Event Timeline, Audit Log, Approval Workflow and directories.

## WhatsApp write flow
WhatsApp → approved-user check → transcription/extraction → classify → equipment/context identification → date/time/shift validation → PostgreSQL correct module → relationships/event timeline/search index update → immediate retrieval.

Clear information may save without unnecessary confirmation. Ambiguous equipment/date/classification requires minimum clarification. Upload/read/convert alone is not permanent-store intent.

## Retrieval
Exact ID → canonical name → alias/abbreviation/transliteration → fuzzy/semantic → current context. Generic pump/motor/bearing/valve/gearbox/pipe/stand terms must not be guessed when multiple assets match.

## Integrity
Exact Equipment, SAP, Material, CAT, Drawing, Part, Manual, SMP and SOP identifiers are preserved from authorised sources. Missing values are not invented. Event time and server entry timestamp remain separate.

Shifts: A 06:00–14:30; B 14:00–22:30; C 22:00–06:30; General 09:00–17:30.

## Production / attendance
Production, Employee Attendance, Contract Worker Attendance and Manpower blocks are pre-created. Later authorised WhatsApp entries can save and retrieve directly. Production modification remains permission-controlled.

## Known extraction limitations
- Some legacy XLS files are preserved/indexed but not all machine-parsed.
- ACCDB/MDB vibration/hydraulic/pneumatic databases still require exact table extraction.
- Scan-only PDF/TIFF/images may require exact extraction before numeric values become validated structured data.
- Original standalone V11 ZIP is unavailable for byte-for-byte comparison.

Never hide these gaps or guess. Use Source not available / Pending exact extraction / Needs Review as appropriate.

## Runtime
GitHub JSON is the reference/import package. PostgreSQL is the live source of truth for new WhatsApp operational data. Live records should not be appended directly to GitHub JSON.

Current manifest: `manifest_v16.json`  
Audit inventory: `source_and_file_audit_v16.json`
