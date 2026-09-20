import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Arabic-letter token of length >= 2. Used to filter which token-pairs are
// safe to propagate into the global ocr_corrections table.
const _ARABIC_TOKEN_RE = /^[؀-ۿ]{2,}$/;
// Pure-Arabic-only string (incl. spaces) — full-cell propagation gate.
const _ARABIC_CELL_RE  = /^[؀-ۿ\s]{2,}$/;

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "غير مصرح" }, { status: 401 });
  }

  // The job must belong to the caller. Without this, any signed-in account
  // could write corrections against someone else's job id -- and those token
  // pairs propagate into the GLOBAL ocr_corrections table below, which the
  // pipeline applies to every future document for every customer. The sibling
  // routes (reprocess, export) have always done this; this one did not.
  const { data: owned } = await supabase
    .from("document_jobs")
    .select("id")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!owned) {
    return NextResponse.json({ error: "المستند غير موجود" }, { status: 404 });
  }

  const body = await req.json();
  const { participant_index, field_name, original_value, corrected_value } = body;

  if (!field_name || original_value === undefined || corrected_value === undefined) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const orig = String(original_value);
  const corr = String(corrected_value);

  // 1. Save the per-cell correction. Used directly by Stage 4.5 of the OCR
  //    pipeline as a column-scoped lookup — every row, even single-shot, takes
  //    effect on the next OCR run for the same column.
  const { error: corrErr } = await supabase.from("field_corrections").insert([{
    job_id:            params.id,
    participant_index: participant_index ?? 0,
    field_name,
    original_value:    orig,
    corrected_value:   corr,
  }]);

  if (corrErr) {
    return NextResponse.json({ error: corrErr.message }, { status: 500 });
  }

  // 2. Propagate token-level changes to the global ocr_corrections table so
  //    the same OCR error is fixed everywhere it appears (across all columns
  //    and documents).
  if (orig && corr && orig !== corr) {
    // Skip phone-like values — phone corrections must never be auto-applied.
    const _digitFraction = orig.replace(/\D/g, "").length / Math.max(orig.length, 1);
    const _isPhoneLike   = /^\d{7,}$/.test(orig.replace(/\D/g, "")) && _digitFraction >= 0.6;

    if (!_isPhoneLike) {
      const origTokens = orig.trim().split(/\s+/);
      const corrTokens = corr.trim().split(/\s+/);

      const changedPairs: Array<{ original_text: string; corrected_text: string }> = [];

      if (origTokens.length === corrTokens.length) {
        // Same token count — align by position, store individual changed pairs.
        for (let idx = 0; idx < origTokens.length; idx++) {
          const o = origTokens[idx];
          const c = corrTokens[idx];
          if (o === c) continue;
          if (!_ARABIC_TOKEN_RE.test(o) || !_ARABIC_TOKEN_RE.test(c)) continue;
          changedPairs.push({ original_text: o, corrected_text: c });
        }
      } else {
        // Different token count — compound name or prefix added/removed.
        // Position alignment would produce wrong pairs; store the full cell.
        if (_ARABIC_CELL_RE.test(orig) && _ARABIC_CELL_RE.test(corr)) {
          changedPairs.push({ original_text: orig, corrected_text: corr });
        }
      }

      if (changedPairs.length > 0) {
        // Single batched RPC; ON CONFLICT (original_text) increments frequency.
        //
        // The result is checked. This call went unchecked and returned 404 for
        // as long as migration 011 sat unapplied — the function simply did not
        // exist. Every correction landed in field_corrections, never reached
        // ocr_corrections, and the route still answered success: true, so the
        // learning loop was dead with nothing to show for it.
        //
        // Still non-fatal: the user's edit is already saved above, and losing
        // the global propagation must not fail their save. But it gets logged.
        // Called with the SERVICE ROLE, not the user's client: migration 040
        // revokes EXECUTE on this function from `authenticated`, because
        // PostgREST publishes every public function and anyone could otherwise
        // rewrite the global correction table. Ownership was already checked
        // above, so the elevated call is scoped by that check.
        //
        // try/catch as well as the error check: createAdminClient() throws when
        // SUPABASE_SERVICE_ROLE_KEY is missing, and a misconfigured deploy must
        // not turn an already-saved edit into a 500.
        try {
          const { error: rpcErr } = await createAdminClient().rpc(
            "upsert_ocr_corrections", { pairs: changedPairs },
          );
          if (rpcErr) {
            console.error(
              "[corrections] upsert_ocr_corrections failed — this correction will "
              + "not be applied to future documents:", rpcErr.message,
            );
          }
        } catch (e) {
          console.error(
            "[corrections] upsert_ocr_corrections could not run — this correction "
            + "will not be applied to future documents:",
            e instanceof Error ? e.message : e,
          );
        }
      }
    }
  }

  return NextResponse.json({ success: true });
}
