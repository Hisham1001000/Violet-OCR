# The security model

Written for anyone reading this repository who wants to know how it keeps one
customer's data away from another, and for anyone about to add a table to it.

Violet stores Arabic handwritten forms — attendance sheets, registration lists,
aid distributions. The rows carry names, phone numbers, ID numbers and dates of
birth of real people, most of them in Gaza. That is the thing being protected.

## The one fact everything follows from

The Supabase **anon key is public**. It ships in the browser bundle of every
page on violetocr.com; anyone can read it out of devtools in ten seconds. It is
not a secret and was never meant to be one.

What follows is the part that is easy to get wrong: PostgREST publishes **every
table, view and function in the `public` schema** at `https://<project>/rest/v1/`,
and that endpoint accepts the anon key. So the real perimeter is not the
website. It is the database. Every object in `public` is an internet-facing
endpoint whether or not any page in this repo calls it.

A `SELECT` the website never issues is still an endpoint. A view nobody links
to is still an endpoint. A function left over from a migration two years ago is
still an endpoint, and it will run.

## The pattern this repository settled on

Row Level Security is necessary and not sufficient. RLS decides which **rows**
you see; it says nothing about which **columns**, and it does not apply at all
to a `SECURITY DEFINER` function or — the one that cost us — to a view.

The pattern, arrived at over migrations 032 → 033 → 039 → 040:

**1. Revoke the whole table from `anon` and `authenticated`.**

Migration 032 tried to revoke at column level and it was a silent no-op. A
table-level grant shadows a column-level revoke: Postgres accepts the statement,
reports success, and the column stays readable. Verified from outside with the
anon key, which is the only check that means anything. 033 explains it in full.

```sql
REVOKE ALL ON public.user_profiles FROM anon, authenticated;
```

**2. Grant back only the columns the website actually needs.**

```sql
GRANT SELECT (user_id, balance_cents, rows_used_total) ON public.user_profiles TO authenticated;
```

This is what stops a customer reading `is_admin`, and — before migration 039 —
what stopped them **writing** their own `balance_cents`. A user could have
credited themselves. Write grants deserve the same column list as read grants,
and 039 exists because they did not have one.

**3. Revoke every `SECURITY DEFINER` function from `PUBLIC`, `anon` and
`authenticated`, and pin its `search_path`.**

A `SECURITY DEFINER` function runs as its owner, which is usually the table
owner, which means it ignores RLS entirely. Left callable by `anon`, it is a
hole shaped exactly like whatever it does. Without a pinned `search_path` it is
also hijackable: a schema earlier in the path can shadow the table it means to
touch.

```sql
ALTER FUNCTION public.settle_job(uuid) SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public.settle_job(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_job(uuid) TO service_role;
```

A route that needs such a function calls it with the service-role client from
the server. `/api/documents/[id]/corrections` is the worked example: it checks
ownership itself, then calls `upsert_ocr_corrections` as the service role.

**4. Views need `security_invoker = on`, and this is the one that bit hardest.**

A view runs with its **owner's** privileges by default. It therefore reads
straight past the RLS of every table under it, and past the column grants of
steps 1 and 2. `extracted_names` (migration 019) was defined this way. A single
unauthenticated `GET` with the public anon key returned every user's extracted
names, document names and document URLs.

```sql
ALTER VIEW public.extracted_names SET (security_invoker = on);
REVOKE ALL ON public.extracted_names FROM anon, authenticated;
```

If you add a view to `public`, it is a hole until you have done this.

**5. A policy named "service role can …" grants nothing to the service role,
and quite a lot to everyone else.**

The service role bypasses RLS. It does not consult policies at all. So a policy
written to let it through only ever widens access for **users** — and when that
policy is `USING (true)`, it widens it to everyone. Migrations 009 and 010 each
made this mistake; 040 replaced them with ownership-scoped policies:

```sql
CREATE POLICY field_corrections_own ON public.field_corrections FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.document_jobs j
    WHERE j.id::text = field_corrections.job_id::text AND j.user_id = auth.uid()
  ));
```

The double cast is not styling. `field_corrections.job_id` is `uuid` in the live
database and `TEXT` in the migration that created it — it was altered by hand
and never recorded. Writing SQL that survives that kind of drift is cheaper than
discovering it in production.

## Checking, rather than believing

Reasoning about grants is how the column-level no-op survived a whole migration.
The only evidence that counts is a request from outside, with the public key:

```bash
python scripts/verify_security.py

# The pipeline check needs the deployed URL. Without it the probe would fall
# back to whatever MODAL_PROCESS_DOCUMENT_URL says locally -- usually
# 127.0.0.1 -- and report SKIPPED, which reads too much like a pass.
VERIFY_MODAL_URL=https://<workspace>--process-document.modal.run python scripts/verify_security.py
```

It makes raw HTTPS calls against the live project with the anon key and prints
`CLOSED` or `STILL OPEN` per check, exiting non-zero if anything is open. It
covers the objects locked in 040 plus regressions for 033 and 039. Write probes
clean up after themselves.

Two notes on reading its output. A `409` from a function is **not** a pass: a
foreign-key error proves the function body ran, which means the caller reached
it. And a check that passes because a table is empty is not a check.

## Where the line between web and database sits

- **Browser → Supabase** with the anon key. Constrained by everything above.
- **Browser → Next.js routes** (`frontend/src/app/api/*`), which run server-side
  and may hold the service-role key. Each route re-derives the user from the
  session and checks ownership itself; admin routes go through `assertAdmin()`
  and write an audit-log row.
- **Next.js → Modal** (the OCR pipeline), authenticated by a shared secret both
  sides compare. It **fails closed**: with the secret unset the pipeline rejects
  the call rather than accepting it. That means a missing environment variable
  stops uploads, which is the correct direction for this trade to fail.
- **Vercel Cron → `/api/cron/reconcile-jobs`**, a bearer token. Also fails
  closed: no `CRON_SECRET`, no run — the route answers 503.

## What is not covered here

- **Storage.** The buckets holding uploaded documents and cell crops are
  managed in the Supabase dashboard, so their access rules are not in this
  repository. The upload route signs URLs with the *user's* client, so the
  rules exist -- they are simply held somewhere this repository cannot show
  you. Capturing them as SQL, the way the tables are captured here, is work
  still to do.
- **A full sweep.** The probe covers the holes that were found. It is not a
  complete enumeration of `pg_policies` and `pg_proc`.
- **The published history.** See [SECURITY.md](../SECURITY.md).

## If you are adding a table

1. Enable RLS and write the owner-scoped policies.
2. `REVOKE ALL` from `anon, authenticated`.
3. `GRANT` back the exact columns the site reads, and separately the exact
   columns it writes.
4. If it is a view: `security_invoker = on`.
5. If it comes with a `SECURITY DEFINER` function: pin `search_path`, revoke
   from `PUBLIC, anon, authenticated`, grant to `service_role`, and call it from
   a server route that checks ownership first.
6. Add a probe to `scripts/verify_security.py` and run it against the live
   project. If it does not fail before your migration, it is not testing
   anything.
