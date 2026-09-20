# `execution/testset/` — the frozen evaluation set

`frozen_test_400.csv` is **deliberately not in the repository**. It is 400 name
crops from real customer documents with their human-verified true labels, plus
the production job ids they came from. It is the most directly identifying file
in the project: full names of real people, one per row.

It is the fixed yardstick every model change is measured against — same crops,
same labels, same scoring — which is what makes comparisons across adapter
versions meaningful. Keep it frozen; a test set that drifts measures nothing.

## Who reads it

- `execution/modal_lora_names.py` — evaluating an adapter against the set
- `execution/modal_make_hw_sheet.py` — generating comparison sheets

Both are offline tools. The live OCR pipeline never touches this file.

## Rebuilding it

There is no script: it was assembled and labelled by hand. To build an
equivalent, export a sample of completed jobs, crop the name cells with
`execution/crop_names.py`, and have someone verify each label. Store the result
here as `frozen_test_400.csv` with columns `id,label,ocr,job`.
