# LMMM AI Maintenance Agent V7.1 — Durable Background Jobs + Fast WhatsApp Path

User-perspective stabilization build based on V7.0.1.

## What changes
- TIFF → PDF and Access → Excel are durable background jobs. WhatsApp conversation remains available while conversion runs.
- Every conversion gets a JOB-xxxxxx ID. `STATUS` shows the latest five jobs and page/table progress.
- Conversion jobs are stored in PostgreSQL. If Render restarts/deploys, interrupted running jobs are re-queued on startup.
- Failed conversion jobs retry automatically up to 3 attempts. `RETRY JOB-xxxxxx` can re-queue a failed job.
- TIFF conversion processes one frame at a time, yields between frames, preserves frame order/aspect ratio, and updates progress checkpoints.
- Duplicate taps for the same source conversion reuse the active queued/running job instead of starting duplicate work.
- TIFF/Access source binding is persisted in PostgreSQL so in-memory state loss after restart does not silently select an unrelated old source.
- Conversion-only remains separate from AI indexing/permanent maintenance knowledge storage.
- Normal WhatsApp webhook is acknowledged immediately; background work is not awaited by the webhook response.
- PDF/Word/Excel and other directly readable documents do not get an unnecessary conversion menu. TIFF/Access keep explicit action choices.
- Existing equipment/date/employee audit, exact identifier preservation, role controls, manual-vs-event routing, and maintenance data model are retained.

## User flow
1. Upload TIFF/Access.
2. Choose Convert.
3. Bot immediately replies that the job started in background and gives its Job ID.
4. Continue asking normal maintenance questions immediately.
5. Send `STATUS` at any time for progress.
6. Completed PDF/XLSX is sent automatically.

## Render
Build command:
`npm install && npm run verify:runtime`

Start command:
`npm start`

Node: 22.x
