# LMMM TDIS, spares, and parts extraction

- `data/tdis_lmmm_drawings.json`: 10,262 rows in the 17029 LMMM series from the TDIS mechanical drawing list. Each retains the drawing ID, title, reference, and source row. The other TDIS prefixes belong to different number series and are not assigned to LMMM here.
- `data/spares_parts_drawing_refs.json`: 3,817 distinct spares/parts rows with drawing references explicitly printed in BDM or furnace spares sheets. All original cells and sheet/row references are retained because column layouts vary. 277 rows explicitly mention an ID present in the LMMM TDIS extract.
- `review/pdf_sms_parts_drawing_ocr_review.json`: 6,028 candidate SMS item/drawing/part rows from the supplied `8470-8471 WBF parts 2(1).pdf`, pages 5–205. This PDF contains mixed material. OCR errors and item ownership must be reviewed before live search imports.

The source archive already contains page text for the TIFF manuals and spares PDFs. These exports add structured lists and explicit links; they do not assert that every PDF/TIFF page was converted to a verified part record. Do not use review rows as confirmed answers. The app must load/import the data files to affect WhatsApp search. Keep access controls on spares and drawing results.
