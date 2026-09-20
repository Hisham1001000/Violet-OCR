# Migrations

Plain `.sql` files, applied in filename order through the Supabase SQL editor.
There is no migration runner and no local Supabase: these files are the record
of what was applied to the live database, in order.

## Applying

Paste a file into **Supabase → SQL Editor → New query** and run it. Each file is
written to be safe to re-run (`IF NOT EXISTS`, `DROP POLICY IF EXISTS`,
`CREATE OR REPLACE`), but check before re-running one that drops something.

## Things that will confuse you

**Two pairs share a number.** `005_ocr_training_data_dedup.sql` /
`005_waitlist.sql`, and `006_admin_tables.sql` /
`006_ocr_training_crop_hash.sql`. They are left as they are on purpose: the
filenames are the record of what ran on production, and renaming them would
make that record a lie. Within a pair, either order works.

**040 must come after its deploy.** `040_lock_remaining_postgrest_surface.sql`
revokes `upsert_ocr_corrections` from `authenticated`. The route that calls it,
`frontend/src/app/api/documents/[id]/corrections/route.ts`, was changed to use
the service role. Apply 040 only once that deploy is live, or saving a corrected
cell silently stops teaching the pipeline (the user still sees their edit
saved — the propagation is non-fatal by design).

**Production has drifted from these files.** `field_corrections.job_id` is
`uuid` in the live database and `TEXT` in `009_corrections_tables.sql`; it was
altered by hand and never recorded. Policies that join on it cast both sides so
they work either way. Assume there may be other drift, and prefer SQL that does
not depend on an exact column type.

**019 was never applied.** `019_extracted_names_view.sql` creates a reporting
view that does not exist in production. It is kept because the SQL is useful,
and it now creates the view with `security_invoker = on` — without that, a view
runs with its owner's privileges and ignores the RLS of the tables beneath it.

## The security pattern in here

The anon key ships in the browser, so everything in the `public` schema is
reachable by anyone at `/rest/v1/`. The pattern these migrations settle on is:

1. **Revoke the whole table** from `anon, authenticated` (032 tried this at
   column level and it was a silent no-op — table-level grants shadow column
   revokes; 033 explains why).
2. **Grant back only the columns** the website needs (033, 039).
3. **Revoke every SECURITY DEFINER function** from `PUBLIC, anon, authenticated`
   and grant it to `service_role` alone (030, 037, 040).
4. **Never trust a policy named "service role can …"** — the service role
   bypasses RLS entirely, so such a policy only ever grants access to *users*
   (009 and 010 made this mistake; 040 removed them).

Verify the result from outside with the public key:

```bash
python scripts/verify_security.py     # expects every row CLOSED
```
