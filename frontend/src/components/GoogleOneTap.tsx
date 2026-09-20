"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/**
 * Google's own sign-in button, rendered on our page.
 *
 * The redirect button sends people to Google's site, and whatever Google shows
 * there is out of our hands: someone with no Google session in that browser --
 * which is everyone arriving from an Instagram ad -- gets an empty "email or
 * phone" box and a password to type. People do not type a password to try a
 * product they met ten seconds ago.
 *
 * This renders Google's button in place instead. It knows which accounts are
 * already on the device, so the choice is "continue as ..." in one tap, with no
 * page leaving and nothing to type. One Tap (the small card at the top of the
 * screen) is offered at the same time.
 *
 * The nonce is what stops a token minted for another site being replayed here:
 * Google receives its hash, Supabase receives the original, and the two are
 * checked against each other.
 *
 * It renders nothing at all when the client id is missing or Google's script is
 * blocked (ad blockers, in-app browsers, no network). The redirect button below
 * it always stays, so sign-in is never left without a route.
 */

// On. It needs violetocr.com registered as an authorised JavaScript origin on
// the client below -- without that it renders and then fails on tap with
// "Access blocked: no registered origin". Set NEXT_PUBLIC_GOOGLE_ONE_TAP=0 to
// fall back to the redirect button if it ever misbehaves.
const ENABLED   = process.env.NEXT_PUBLIC_GOOGLE_ONE_TAP === "1";
const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
const SCRIPT_SRC = "https://accounts.google.com/gsi/client";

interface GoogleIdApi {
  accounts: {
    id: {
      initialize: (o: Record<string, unknown>) => void;
      renderButton: (el: HTMLElement, o: Record<string, unknown>) => void;
      prompt: () => void;
    };
  };
}

function loadGoogleScript(): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") return resolve(false);
    if ((window as unknown as { google?: GoogleIdApi }).google?.accounts?.id) return resolve(true);

    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(true));
      existing.addEventListener("error", () => resolve(false));
      return;
    }
    const s = document.createElement("script");
    s.src = SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

export function GoogleOneTap({
  next = "/dashboard",
  lang = "ar",
  onError,
  onRendered,
}: {
  next?: string;
  lang?: string;
  onError?: (message: string) => void;
  /** Fires once Google's button is actually on screen, so the page can drop its own. */
  onRendered?: () => void;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);

  const router = useRouter();
  const fail = useCallback((m: string) => onError?.(m), [onError]);

  useEffect(() => {
    if (!ENABLED || !CLIENT_ID) return;
    let cancelled = false;

    (async () => {
      // Google is given the hash of this nonce, Supabase the nonce itself.
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const rawNonce = btoa(String.fromCharCode(...Array.from(bytes)));
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawNonce));
      const hashedNonce = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      const ok = await loadGoogleScript();
      if (!ok || cancelled) return;

      const google = (window as unknown as { google?: GoogleIdApi }).google;
      if (!google?.accounts?.id || !holder.current) return;

      google.accounts.id.initialize({
        client_id: CLIENT_ID,
        nonce: hashedNonce,
        use_fedcm_for_prompt: true,
        callback: async (response: { credential?: string }) => {
          if (!response?.credential) return;
          setBusy(true);
          // Signing in with Google means staying signed in, the same as ticking
          // the box; SessionGuard signs out a session that carries no flag.
          try { localStorage.setItem("violet_remember", "1"); } catch { /* private mode */ }

          const supabase = createClient();
          const { error } = await supabase.auth.signInWithIdToken({
            provider: "google",
            token: response.credential,
            nonce: rawNonce,
          });
          if (error) {
            setBusy(false);
            fail(error.message);
            return;
          }
          router.replace(next);
          router.refresh();
        },
      });

      google.accounts.id.renderButton(holder.current, {
        type: "standard",
        theme: "outline",
        size: "large",
        text: "continue_with",
        shape: "pill",
        logo_alignment: "center",
        // Always English. Google's Arabic rendering of its own brand
        // ("المتابعة باستخدام جوجل") reads as a translated stranger next to the
        // rest of the card; the English wordmark is what people recognise.
        locale: "en",
        width: Math.min(holder.current.offsetWidth || 320, 400),
      });
      setShown(true);
      onRendered?.();

      // The One Tap card, for anyone already signed in to Google here.
      google.accounts.id.prompt();
    })();

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [next, lang, router, fail]);

  if (!ENABLED || !CLIENT_ID) return null;

  return (
    <div style={{ marginBottom: shown ? 10 : 0 }}>
      <div ref={holder} style={{ display: "flex", justifyContent: "center", minHeight: shown ? 44 : 0 }} />
      {busy && (
        <p style={{ textAlign: "center", fontSize: 12, color: "#9ca3af", margin: "8px 0 0" }}>
          {lang === "ar" ? "جارٍ تسجيل الدخول…" : "Signing you in…"}
        </p>
      )}
    </div>
  );
}
