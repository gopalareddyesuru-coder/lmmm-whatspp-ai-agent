# LMMM AI Maintenance Agent V6.3.1

Render port-binding stabilization build.

## Render commands
Build: `npm install && npm run verify:runtime`
Start: `npm start`

## Runtime checks
- HTTP server explicitly binds to `0.0.0.0` and `process.env.PORT` (fallback 10000).
- Startup logs print the actual bound address.
- Build verifier checks sharp, pdf-lib, mdb-reader and xlsx.
- `/health` reports TIFF→PDF and Access→Excel converter availability.

Upload the complete ZIP contents to the repository root. Keep only this README.
