# LMMM manual item and major drawing mapping

`data/manual_equipment_item_index.json` maps equipment item numbers from charging through finishing to their manual pages. Eight numbers (20–24, 67–68, 72) remain unconfirmed in the checked manuals.

`data/manual_verified_item_drawings.json` contains 97 major drawing links cross-matched by item number and drawing number against an independent drawing list. The drawing number preserves the form in the list; the manual page and list row are retained for audit.

`review/manual_major_drawings_ocr_review.json` contains further OCR candidates. Do not index this review file as confirmed drawing data. Drawing prefixes, sheet suffixes, and some titles require inspection of original scanned pages.

Uploading this ZIP to GitHub stores the data files. The WhatsApp app must explicitly load them or import them into its search database; this package does not by itself deploy or alter live search.
