const checks = [
  ["sharp", async()=>{ const m=await import("sharp"); if(!(m.default||m)) throw new Error("no export"); }],
  ["pdf-lib", async()=>{ const m=await import("pdf-lib"); if(!m.PDFDocument) throw new Error("PDFDocument missing"); }],
  ["mdb-reader", async()=>{ const m=await import("mdb-reader"); if(!(m.default||m.MDBReader)) throw new Error("MDBReader missing"); }],
  ["xlsx", async()=>{ const m=await import("xlsx"); if(!(m.read||m.default?.read)) throw new Error("XLSX read missing"); }]
];
let failed=false;
for (const [name,fn] of checks){ try { await fn(); console.log(`[OK] ${name}`); } catch(e){ failed=true; console.error(`[FAIL] ${name}: ${e.message}`); }}
if(failed) process.exit(1);
console.log("[OK] Converter runtime dependencies verified");
