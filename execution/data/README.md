# `execution/data/` — lexicons the pipeline reads

The JSON files this folder holds at runtime are **deliberately not in the
repository**. They are derived from documents real people submitted to Violet:
family names, given names and place names from Gaza, with occurrence counts.
Publishing them would publish a dataset about a population that never agreed to
be in a public repository.

| File | What it is | Rebuild with |
|---|---|---|
| `arabic_names_training.json` | Name vocabulary used to score OCR candidates | `python execution/build_name_vocab.py` |
| `arabic_names_learned.json` | Names promoted from `name_candidates` after review | `python execution/grow_name_dict.py promote` |
| `gaza_places.json` | Approved place-name spellings | `python execution/build_place_lexicon.py` |
| `gaza_places_draft.json`, `gaza_places_seed.json` | Working files for the above | same |

## What happens without them

Nothing crashes. `execution/ocr_voter.py` checks `if p.exists()` before loading,
and `execution/place_lexicon.py` returns an empty lexicon when the approved file
is absent. **That is the danger**: name accuracy drops and nothing says so.

So if you are running the pipeline, make sure these files are present on the
machine you deploy from. Modal ships the local working tree, not git, and it
does not read `.gitignore` — untracked files are uploaded normally.

## For anyone cloning this repository

You do not need these files to read the code, run the frontend, or run the
offline tests. You need them to reproduce Violet's name accuracy, and they are
not ours to hand out. Build your own from your own data with the scripts above.

## `name_hints.json`

The 23 given names and 24 local family names that are spliced into the Gemini
OCR prompt as a spelling hint. They used to be hardcoded in
`extract_gemini_ocr.py`; they are corpus-derived, so they belong here with the
rest of the withheld data rather than in the published source.

The file carries `hint_block` — the prompt text verbatim, wrapping included, so
the prompt is byte-for-byte what it was when the list lived inline — plus
`first_names` and `family_names` arrays, which the loader falls back to and
which are the maintainable form.

Without this file the pipeline builds the prompt with no hint and **says so only
at log level info**. Nothing errors; local family names are simply read less
well. Build your own from your corpus with the same two keys.
