"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * GuestClaim — picks up a sheet uploaded from the landing page before sign-up.
 *
 * The landing page (public/landing.html) keeps `violet_guest_job` in
 * localStorage: `{ id, token }`. On the first signed-in page this finds it,
 * moves the job into the account (/api/guest/claim), and opens the document.
 * Mounted in the (app) layout, which every sign-in path lands in — email,
 * Google and confirmation links alike — so no redirect needs threading through.
 *
 * The key is removed once the server gives a final answer; a dropped
 * connection leaves it in place so the next page load tries again.
 */
const KEY = "violet_guest_job";

export function GuestClaim() {
  const router = useRouter();

  useEffect(() => {
    let saved: { id?: string; token?: string } | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
    } catch {
      saved = null;
    }
    if (!saved?.id || !saved?.token) return;

    const { id, token } = saved;
    fetch("/api/guest/claim", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ job_id: id, token }),
    })
      .then(async (res) => {
        if (res.status === 401 || res.status === 429 || res.status >= 500) return;  // try again later
        try { localStorage.removeItem(KEY); } catch { /* storage blocked */ }
        const data = await res.json().catch(() => ({}));
        if (data.result === "claimed") router.push(`/documents/${id}`);
      })
      .catch(() => { /* offline: keep the key for the next page load */ });
  }, [router]);

  return null;
}
