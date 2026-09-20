# Security

Violet processes Arabic handwritten forms that carry the names, phone numbers,
ID numbers and dates of birth of real people. Security reports are welcome and
will be taken seriously.

## Reporting a vulnerability

Email **violetocr4@gmail.com** with "security" in the subject. Please include
what you found, how to reproduce it, and what you were able to reach. You will
get an acknowledgement within 72 hours.

Please do not open a public issue for anything that exposes customer data.

If you are probing the live site at violetocr.com: test against your own
account. Do not attempt to read another user's documents, do not run automated
scanners against the production database, and stop as soon as you have enough
to write the report. Findings reported in good faith under those limits will
not be pursued.

This is a small project with no bug-bounty budget. Credit in the fix commit is
what is on offer, and it is offered sincerely.

## How the system is designed to hold

[docs/security-model.md](docs/security-model.md) describes it properly. The
short version: the Supabase anon key is public, so every table, view and
function in the `public` schema is an internet-facing endpoint. Access is
controlled by revoking the table and granting back specific columns, by pinning
and revoking `SECURITY DEFINER` functions, and by `security_invoker` on views —
not by RLS alone, which governs rows and says nothing about columns.

`scripts/verify_security.py` checks that posture from outside using the public
key. Run it after any migration that touches grants.

## What this repository does not cover

Some of the system is configured outside the code, and some of it is still
being worked on. These are stated so you know where reading the source will
not tell you the whole story.

- **Storage is configured outside this repository.** The buckets holding
  uploaded documents and cell crops are managed in the Supabase dashboard, so
  reading this repository tells you nothing about their access rules. Reports
  about storage are welcome and will be checked against the live configuration.
- **Signed URLs are used for admin exports.** Their lifetime is set in the
  route rather than in policy, and is being reviewed.
- **The pre-publication git history is not in this repository.** The published
  repository starts from a single clean commit. The private archive it was cut
  from contains two files with roughly thirty real people's details, committed
  and later deleted. It remains private and is not being deleted, because it is
  the only copy of the project's history.
- **The security probe is not exhaustive.** It covers the holes that were found
  and fixed. It is not a full enumeration of database policies and functions.

## Scope

In scope: violetocr.com, the Supabase project behind it, and the Modal
endpoints the web app calls.

Not in scope: findings that require access to an account you do not control,
denial of service, and reports from automated scanners with no demonstrated
impact.
