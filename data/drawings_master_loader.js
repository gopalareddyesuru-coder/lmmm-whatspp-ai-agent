// LMMM drawings master loader — loads four GitHub-uploadable JSON parts.
import { readFileSync } from 'node:fs';

const DRAWING_MASTER_FILES = [
  new URL('./drawings_master.json', import.meta.url),
  new URL('./drawings_master_1.json', import.meta.url),
  new URL('./drawings_master_2.json', import.meta.url),
  new URL('./drawings_master_3.json', import.meta.url),
];

export function loadDrawingsMaster() {
  const drawings = [];
  let metadata;
  // Parse each part in turn to limit temporary startup memory.
  for (const file of DRAWING_MASTER_FILES) {
    const part = JSON.parse(readFileSync(file, 'utf8'));
    metadata ??= part;
    if (Array.isArray(part.drawings)) drawings.push(...part.drawings);
  }
  return {
    schema_version: metadata?.schema_version || '1',
    department_code: metadata?.department_code || '35',
    department: metadata?.department || 'LMMM',
    record_count: drawings.length,
    drawings,
  };
}

export const DRAWINGS_MASTER = loadDrawingsMaster();
