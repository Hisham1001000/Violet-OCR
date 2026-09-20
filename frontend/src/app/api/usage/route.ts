import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ROW_PRICE_TENTHS, rowsAffordable } from "@/lib/billing";
import type { UsageResponse } from "@/lib/types";

export async function GET() {
  const supabase = createClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "غير مصرح" }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from("user_profiles")
    .select("*")
    .eq("user_id", user.id)
    .single();

  // A missing profile row reads as zero rather than as an error: the signup
  // trigger creates it, and a user who somehow has none should see an empty
  // balance and a top-up prompt, not a broken page.
  const balance_cents = profile?.balance_cents ?? 0;
  const rows_used     = profile?.rows_used_total ?? 0;

  // Everything ever spent, and everything ever held. Together they give the
  // "X used of Y" bar in the top bar without a second query. settle_job counts
  // spend in cents (migration 035): rows × price stopped being right the day
  // the price changed, because older rows were bought at the older price.
  //
  // select("*") rather than naming cents_spent_total: naming a column that
  // does not exist yet fails the whole query, and a failed profile read shows
  // every user a $0 balance. Before 035 has run, every row was bought at 1 cent,
  // so rows used IS cents spent.
  const spent_cents    = profile?.cents_spent_total ?? rows_used;
  const lifetime_cents = balance_cents + spent_cents;

  const body: UsageResponse = {
    balance_cents,
    spent_cents,
    lifetime_cents,
    rows_used_total: rows_used,
    rows_affordable: rowsAffordable(balance_cents),
    row_price_cents: ROW_PRICE_TENTHS / 10,
    // Uploading needs some credit; how much a document costs is not knowable
    // until it has been read.
    can_upload: balance_cents > 0,
    is_admin:   !!profile?.is_admin,
    is_trainer: !!profile?.is_trainer,
  };

  return NextResponse.json(body);
}
