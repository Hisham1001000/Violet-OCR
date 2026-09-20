# `execution/` — the OCR pipeline

Flat on purpose. Splitting these into `pipeline/`, `engines/` and `apps/` would
read better, but every import in ~30 files would change, Modal deploys the
working tree by path, and the only way to prove the pipeline still works is a
real upload that costs paid Azure, Gemini and GPU time. This file buys the
navigability without that risk; revisit the folder split when an end-to-end test
exists to catch a broken import before a customer does.

## Entry points — something outside calls these

| File | What calls it |
|---|---|
| `modal_webhook.py` | The website. Modal app `claude-orchestrator`; `POST /process-document` is the real door. Deploy with `modal deploy execution/modal_webhook.py` |
| `local_server.py` | The same endpoints on `127.0.0.1:8001` for local runs (`python start.py`) |
| `modal_lora_names.py` | Separate GPU app holding the fine-tuned name adapters. `lora_names.py` calls it at runtime by name, not by import, so it deploys on its own schedule |

## The pipeline, in the order `process_document.py` uses it

`process_document.py` (`run_pipeline`) is the orchestrator; every stage is
imported lazily inside the function body, so a broken stage fails that stage
rather than the import.

| Stage | File | Job |
|---|---|---|
| Layout | `extract_azure_layout.py` | Azure Document Intelligence: table structure and cell polygons. Irreplaceable — no polygons, no crops |
| OCR engines | `extract_azure.py`, `extract_gemini_ocr.py`, `extract_vision.py` | Read the page. Several engines, deliberately |
| Names | `crop_names.py` → `lora_names.py` | Cut each name cell, read it with the fine-tuned adapters |
| Merge | `merge_ocr_outputs.py`, `ocr_voter.py`, `spatial_matcher.py` | Reconcile the engines into one table; vote per cell |
| Structure | `extract_gemini.py` | Turn the merged text into rows and columns |
| Quality | `ocr_quality.py` | Mathematical reconciliation, Arabic-numeral folding |
| Repair | `digit_repair.py` | Re-read only the numeric cells that fail validation |
| Judge | `gemini_judge.py` | Stage 3.95: review low-confidence cells. Always on |
| Places | `place_lexicon.py` | Correct Gaza place names against the approved list |
| Output | `generate_excel.py` | RTL Arabic `.xlsx` |
| Learning | `grow_name_dict.py` | Collect and promote names for the vocabulary |
| Support | `pipeline_trace.py`, `alerts.py`, `compress_context_images.py` | Debug trace, Slack alerts on stage failure, image prep |

## Offline tools — run by hand, never by the pipeline

`build_name_vocab.py`, `build_place_lexicon.py` (build the lexicons in
`data/`), `archive_crops.py`, `modal_make_hw_sheet.py`, `modal_k6.py`.

## The webhook orchestrator

`modal_webhook.py` also exposes `/directive`, which runs a markdown SOP from
`directives/` through Claude with the tools in `tools/`, registered via
`webhooks.json`. It is separate from the OCR path and currently registers one
slug with no tools.

## What is not here

`data/` and `testset/` hold files derived from real customer documents and are
withheld from the repository. See their READMEs. The pipeline runs without them
and **loses name accuracy silently** — no error, just worse results.
