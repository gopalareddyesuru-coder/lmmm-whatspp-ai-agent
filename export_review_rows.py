#!/usr/bin/env python3
"""Stream the two private review indexes as JSON lines without modifying them."""
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import zipfile

INDEXES = (
    ("LMMM_SOURCE_REVIEW_SEARCH_2026-09-27.sqlite3", 431414),
    ("LMMM_ACCESS_SEARCH_2026-09-27.sqlite3", 5174),
)


def main(archive_path):
    with zipfile.ZipFile(archive_path) as archive, tempfile.TemporaryDirectory() as directory:
        for name, expected in INDEXES:
            path = os.path.join(directory, name)
            with archive.open(name) as source, open(path, "wb") as target:
                shutil.copyfileobj(source, target, 1024 * 1024)
            connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
            try:
                if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                    raise ValueError(f"Source index integrity check failed: {name}")
                count = connection.execute("SELECT count(*) FROM source_record").fetchone()[0]
                if count != expected:
                    raise ValueError(f"Unexpected source index count: {name}: {count}")
                cursor = connection.execute("""SELECT source_file,archive_member,source_sha256,
                       location,status,candidate_area,mapping_state,content_type,source_text
                       FROM source_record ORDER BY id""")
                keys = [item[0] for item in cursor.description]
                for row in cursor:
                    print(json.dumps(dict(zip(keys, row)), ensure_ascii=False, separators=(",", ":")))
            finally:
                connection.close()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("Usage: export_review_rows.py PRIVATE_SEARCH_ZIP")
    main(sys.argv[1])
