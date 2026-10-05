LMMM AI Maintenance V8.15.35 — Drawings Master Integration

BASE FILE:
app(10).js — V8.15.34 TOD EQUIPMENT ALIASES supplied by the user.

CHANGE SCOPE ONLY:
1. Added import for data/drawings_master_loader.js.
2. Added read-only two-file drawing-master search.
3. Inserted that search before the existing ECS/drawing-list fallbacks.
4. Existing registration, permissions, ingestion, history, safety, production,
   equipment aliases and prior search functions were preserved.

DRAWING RULES:
- Search both data/drawings_master.json and data/drawings_master_1.json.
- Exact drawing numbers are punctuation-insensitive.
- Return direct Google Drive link when present.
- Do not collapse repeated drawing numbers; they can be pages/revisions/copies.
- Preserve descriptive-name copies.
- Explicit BDM and BAR MILL terms receive strong area scoping to reduce cross-retrieval.
- Existing ECS/drawing search remains as fallback when JSON master has no result.

VALIDATION:
node --check app.js = PASS

GITHUB:
Replace the current app.js with the app.js in this ZIP.
Keep these existing files:
data/drawings_master.json
data/drawings_master_1.json
data/drawings_master_loader.js

TEST AFTER DEPLOY:
MEC-1-D-33577 drawing
MEC1D33577 drawing
170690 drawings
ecs drawings
bdm ecs drawings
bar mill furnace drawings
bp-1 drawings
gearbox drawing
