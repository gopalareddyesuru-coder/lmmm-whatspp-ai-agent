// LMMM drawings master loader — loads four GitHub-uploadable JSON parts.
import { readFileSync } from 'node:fs';

const DRAWING_MASTER_FILES = [
  new URL('./drawings_master.json', import.meta.url),
  new URL('./drawings_master_1.json', import.meta.url),
  new URL('./drawings_master_2.json', import.meta.url),
  new URL('./drawings_master_3.json', import.meta.url),
];

export function loadDrawingsMaster() {
  const parts = DRAWING_MASTER_FILES.map(file => JSON.parse(readFileSync(file, 'utf8')));
  const drawings = parts.flatMap(part => Array.isArray(part.drawings) ? part.drawings : []);
  return {
    schema_version: parts[0]?.schema_version || '1',
    department_code: parts[0]?.department_code || '35',
    department: parts[0]?.department || 'LMMM',
    record_count: drawings.length,
    drawings,
  };
}

export const DRAWINGS_MASTER = loadDrawingsMaster();
