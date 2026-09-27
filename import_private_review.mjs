#!/usr/bin/env node
// Private, idempotent archive import. Defaults to validation without database writes.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {dirname,join,resolve} from 'node:path';

const archive=process.argv.find(x=>x.endsWith('.zip'));
const doImport=process.argv.includes('--import');
if(!archive){console.error('Usage: node import_private_review.mjs PRIVATE_SEARCH_ZIP [--import]');process.exit(2);}
if(doImport&&!process.env.DATABASE_URL){console.error('DATABASE_URL environment variable required for --import');process.exit(2);}
const helper=join(dirname(fileURLToPath(import.meta.url)),'export_review_rows.py');
const child=spawn('python3',[helper,resolve(archive)],{stdio:['ignore','pipe','inherit']});
let connection,pg,rows=0,inserted=0,batch=[];
const ddl=`CREATE TABLE IF NOT EXISTS lmmm_source_review(
  source_key TEXT PRIMARY KEY,source_file TEXT NOT NULL,archive_member TEXT NOT NULL,
  source_sha256 TEXT,location TEXT NOT NULL,extraction_status TEXT NOT NULL,
  candidate_area TEXT NOT NULL,mapping_state TEXT NOT NULL,
  content_type TEXT NOT NULL,source_text TEXT NOT NULL)`;
async function flush(){
  if(!batch.length||!connection){batch=[];return;}
  const payload=JSON.stringify(batch);batch=[];
  const result=await connection.query(`INSERT INTO lmmm_source_review
    (source_key,source_file,archive_member,source_sha256,location,extraction_status,
     candidate_area,mapping_state,content_type,source_text)
    SELECT source_key,source_file,archive_member,source_sha256,location,status,
           candidate_area,mapping_state,content_type,source_text
    FROM jsonb_to_recordset($1::jsonb) AS x(
      source_key text,source_file text,archive_member text,source_sha256 text,
      location text,status text,candidate_area text,mapping_state text,
      content_type text,source_text text)
    ON CONFLICT (source_key) DO NOTHING`,[payload]);
  inserted+=result.rowCount;
}
try{
  if(doImport){
    pg=(await import('pg')).default;
    connection=new pg.Client({connectionString:process.env.DATABASE_URL,
      ssl:process.env.DATABASE_URL.includes('localhost')?false:{rejectUnauthorized:false}});
    await connection.connect();
    await connection.query(ddl);
    await connection.query('SELECT pg_advisory_lock(35081519)');
  }
  for await(const line of createInterface({input:child.stdout,crlfDelay:Infinity})){
    const row=JSON.parse(line);
    const key=[row.source_file,row.archive_member,row.source_sha256||'',row.location].join('\0');
    row.source_key=createHash('sha256').update(key).digest('hex');
    rows++;batch.push(row);
    if(batch.length>=200)await flush();
  }
  const exitCode=child.exitCode??await new Promise(resolveExit=>child.on('close',resolveExit));
  if(exitCode!==0||rows!==436588)throw Error(`Incomplete export: ${rows} rows, Python exit ${exitCode}`);
  await flush();
  if(connection){
    await connection.query(`CREATE INDEX IF NOT EXISTS idx_source_review_search
      ON lmmm_source_review USING GIN
      (to_tsvector('simple',source_file||' '||archive_member||' '||source_text))`);
    console.log(`Review rows checked: ${rows}; newly inserted: ${inserted}. Database search index ready.`);
  }else console.log(`Dry run passed: ${rows} source rows validated; no database changes.`);
}catch(error){child.kill();console.error('Import failed:',error.message);process.exitCode=1;
}finally{
  if(connection){await connection.query('SELECT pg_advisory_unlock(35081519)').catch(()=>{});
    await connection.end().catch(()=>{});}
}
