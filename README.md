# LMMM Maintenance AI — V7.3.1 Access All Tables Fix

Build: `npm install && npm run verify:runtime`
Start: `npm start`

## Access conversion safety
- Discovers normal and linked Access user tables and unions the results.
- Converts every discovered readable table into its own XLSX worksheet.
- Preserves empty-table column headers where the reader exposes them.
- Reports discovered/converted table counts and total rows.
- If any table cannot be read, reports PARTIAL with failed table names instead of silently saying COMPLETE.
- Conversion only never stores maintenance records.

Note: saved Access forms/reports and queries are not the same as tables. This converter promises all reader-discoverable user tables; unsupported Access objects are not silently represented as tables.
