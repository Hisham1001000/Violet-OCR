# Violet OCR

Turns photographs of handwritten Arabic forms into spreadsheets.

The forms are attendance sheets, registration lists and aid distributions —
paper tables filled in by hand, in Arabic, photographed on a phone. General OCR
does badly on them: the handwriting is cursive, the columns are hand-ruled, and
the names are Gaza family names that no general model has seen enough of. The
pipeline in `execution/` reads them into a table you can open in Excel.

It runs in production at [violetocr.com](https://violetocr.com), on prepaid
credit charged per extracted row.

Licensed under [PolyForm Noncommercial 1.0.0](LICENSE.md) — read it, fork it,
learn from it, but do not run it as a competing service.

## How it fits together

Three pieces, each doing the thing it is good at.

| | What runs there | Why there |
|---|---|---|
| **`frontend/`** | Next.js 14 (App Router) on Vercel | The website, the API routes, the admin console |
| **Supabase** | Postgres, auth, storage | One database, with Row Level Security as the boundary between customers |
| **`execution/`** | Python on [Modal](https://modal.com) | The OCR pipeline: GPU, paid vision APIs, 30–90 seconds a document |

The split matters for one reason: a Vercel serverless function cancels an
in-flight fetch the moment it returns. A pipeline run takes a minute or more, so
it cannot live behind the web request that started it.

### What happens when someone uploads a form

Traced through the real call path rather than described in the abstract:

1. **`POST /api/upload`** ([route](frontend/src/app/api/upload/route.ts)) —
   authenticates, checks the account has credit, writes the file to Supabase
   storage, inserts a `document_jobs` row with status `pending`, and signs a URL
   for it.
2. The same route then calls **`MODAL_PROCESS_DOCUMENT_URL`**, carrying
   `PIPELINE_SHARED_SECRET`. If that variable is missing the job is marked
   `failed` immediately rather than left hanging.
3. **`process_document_webhook`** ([modal_webhook.py](execution/modal_webhook.py))
   checks the shared secret, `.spawn()`s the real work onto a separate Modal
   worker and returns **202 in under a second**. The spawn is the whole point —
   it is what survives Vercel hanging up.
4. **`run_pipeline`** ([process_document.py](execution/process_document.py))
   does the work, updating `document_jobs.status` as it goes. The stages are
   listed in [execution/README.md](execution/README.md); in outline: Azure
   Document Intelligence for table structure and cell polygons → several OCR
   engines in parallel → fine-tuned name adapters on the cropped name cells →
   a per-cell vote → Gemini for row/column structure → validation, digit repair
   and a judging pass over low-confidence cells → an RTL Arabic `.xlsx`.
5. The browser polls the job row. When it reads `completed`, the table appears
   and the account is charged for the rows that were actually extracted.

Steps 3–5 never touch the web server again. The database is the channel.

## Running it

You need Node 18+, Python 3.10+, a Supabase project, and — for anything beyond
the UI — an Azure Document Intelligence key and a Gemini key. The pipeline will
not produce a table without Azure: nothing else supplies the cell polygons.

```bash
cp .env.example .env          # fill it in; see the table below
pip install -r requirements.txt
cd frontend && npm install && cd ..
```

Apply the SQL in `supabase/migrations/` in filename order through the Supabase
SQL editor. Read [supabase/migrations/README.md](supabase/migrations/README.md)
first — there is no migration runner, two pairs of files share a number on
purpose, and one file must not be applied before its matching deploy is live.

Then, from the repository root:

```bash
python start.py               # pipeline on :8001, website on :3000
```

`start.py` frees both ports first, which is the only reason it exists.

### Environment variables

`.env.example` is the full list with notes. The ones without which nothing
works:

| Variable | Used by | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser, server | The anon key is **public by design** — it ships in the bundle. Read [docs/security-model.md](docs/security-model.md) before adding a table |
| `SUPABASE_SERVICE_ROLE_KEY` | server routes, pipeline | Bypasses RLS entirely. Never give it a `NEXT_PUBLIC_` prefix |
| `PIPELINE_SHARED_SECRET` | web → pipeline | Both sides compare it. **Fails closed**: unset, the pipeline refuses the call, so uploads stop rather than run unauthenticated |
| `MODAL_PROCESS_DOCUMENT_URL` | web | Where uploads are handed off |
| `AZURE_DI_ENDPOINT` / `AZURE_DI_KEY` | pipeline | Table structure and cell polygons. Irreplaceable |
| `GEMINI_API_KEY` | pipeline | Structuring, the judging pass, and one OCR engine |
| `CRON_SECRET` | cron route | Bearer token for the stuck-job watchdog. Unset → 503 |

In production the website reads these from Vercel and the pipeline from the
Modal secret `claude-orchestrator-secrets`. `PIPELINE_SHARED_SECRET` has to be
set, and identical, in both.

### Deploying the pipeline

```bash
modal deploy execution/modal_webhook.py
```

**Modal ships your local working tree and does not read `.gitignore`.** Whatever
is in the folder is what runs. That cuts both ways: secrets on disk are not
uploaded as code, but the data files this repository withholds (below) must be
present locally or the pipeline deploys and runs with empty lexicons — no error,
just worse names.

## Tests

```bash
python tests/test_value_normalization.py    # and the four others in tests/
```

Five offline tests, no API keys, no credits. They cover the parts where a wrong
answer is silent rather than loud: Arabic value normalisation, table shapes,
crop geometry, header structure, place-name matching. Several read the real
patterns out of `process_document.py` rather than copying them, so the test
exercises the shipped code and cannot drift from it.

```bash
python scripts/verify_security.py           # expects every row CLOSED
```

Probes the live database from outside with the public anon key. Run it after
any migration that touches grants.

`test_billing_live.py` writes to whatever database it is pointed at and refuses
to run without `ALLOW_LIVE_BILLING_TEST=1`. It is run by hand, never in CI.

## What is deliberately not in this repository

Not oversights. Each one is withheld for a reason.

- **The name and place lexicons** (`execution/data/`) and the **frozen
  evaluation set** (`execution/testset/`). These are built from documents real
  people submitted — Gaza family names, and 400 verified full names. They are
  the project's most valuable asset and the most sensitive thing it holds.
  Rebuildable from your own data with `build_name_vocab.py` and
  `build_place_lexicon.py`; see the README in each folder.
- **The fine-tuned name adapters.** The weights are trained on the same
  customer documents.
- **Storage bucket policies.** Managed in the Supabase dashboard rather than
  captured as SQL. See [SECURITY.md](SECURITY.md) for what this repository
  does not cover.
- **The git history before publication.** This repository begins at one clean
  commit. The private archive it was cut from contains two files with real
  people's details.
- **Local-only scripts**: Colab training notebooks (one embeds production crop
  ids), a debug harness pinned to local paths, a test-sheet generator holding
  realistic ID and phone numbers.
- **Third-party skill packs** under `.claude/`, which carry their own licences
  and are not ours to redistribute.

## Known issues

Stated rather than tidied away.

- **`GEMINI_MODEL` defaults disagree across files** — `gemini-2.5-flash` in
  five, `gemini-3.7-flash` in three. On Modal it never shows, because
  `modal_webhook.py` sets the variable for every call. Run `local_server.py`
  without setting it and you get a mixed-model pipeline. Left alone on purpose:
  editing eight defaults changes live behaviour the day that one env line moves.
- **Production has drifted from the migration files.** One column is `uuid`
  live and `TEXT` in the migration that created it, altered by hand and never
  recorded. Assume there may be more.
- **Two i18n mechanisms coexist** in the frontend. Unifying them touches every
  Arabic string in the product, with no end-to-end tests to catch a mistake.
- **No E2E tests.** The table editor — the most intricate component in the
  project — is verified by a person clicking through it.
- **Migrations are applied by hand.** There is no runner and no local Supabase;
  the files are the record of what was run on production, in order.

## Layout

```
frontend/          Next.js 14 app — site, API routes, admin console
  src/app/         App Router; (app) is the signed-in route group
  src/components/  React components
  src/lib/         Server and shared modules; server-only ones say so
execution/         The Python OCR pipeline and the Modal apps — flat by
                   design, with a file-by-file map in its README
supabase/          SQL migrations, applied in filename order
tests/             Offline tests, no API keys needed
scripts/           Operational tools, including the security probe
directives/        Markdown SOPs for the webhook orchestrator
k6/                Load-test scripts
docs/              Longer-form documentation
```

## Security

Reports: [SECURITY.md](SECURITY.md). How it is built to hold, and how to add a
table without opening a hole: [docs/security-model.md](docs/security-model.md).
The short version is that the anon key is public, so everything in the database
is an internet-facing endpoint — and RLS alone does not cover columns, views or
`SECURITY DEFINER` functions.
