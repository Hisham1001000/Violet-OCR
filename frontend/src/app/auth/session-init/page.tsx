"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

function SessionInitInner() {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const next         = searchParams.get("next") ?? "/dashboard";

  useEffect(() => {
    // OAuth sign-in defaults to "remembered" — matches user expectations
    // for "Sign in with Google" persisting across browser restarts.
    localStorage.setItem("violet_remember", "1");

    // A Google sign-in and a Google sign-UP arrive at the same place. Report the
    // registration only when the account itself is seconds old, so returning
    // users are not counted as new signups.
    createClient().auth.getUser().then(({ data }) => {
      const created = data.user?.created_at ? Date.parse(data.user.created_at) : NaN;
      if (Number.isFinite(created) && Date.now() - created < 120_000) {
        (window as unknown as { fbq?: (...a: unknown[]) => void }).fbq?.("track", "CompleteRegistration", { method: "google" });
      }
    }).catch(() => {});

    router.replace(next);
  }, [next, router]);

  return null;
}

export default function SessionInitPage() {
  return (
    <Suspense>
      <SessionInitInner />
    </Suspense>
  );
}
