"use client";

import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * SessionGuard — enforces "remember me" behaviour.
 *
 * Logic:
 *  - If the user signed in with "remember me" ON  → localStorage has `violet_remember=1`
 *    → do nothing, session persists normally.
 *
 *  - If the user signed in with "remember me" OFF → sessionStorage has `violet_session=1`
 *    → session is tab-scoped. When the browser is closed (sessionStorage cleared)
 *      and the user reopens the app, sessionStorage is empty but a Supabase auth
 *      cookie still exists → we sign them out immediately.
 *
 * Mount this once inside the authenticated layout (not the auth page).
 */
export function SessionGuard() {
  useEffect(() => {
    const remember = localStorage.getItem("violet_remember");
    const session  = sessionStorage.getItem("violet_session");

    // Has an active Supabase session but neither storage flag is set
    // → this is a fresh browser open after a "no remember" login → sign out
    if (!remember && !session) {
      const supabase = createClient();
      supabase.auth.getSession().then(({ data }) => {
        if (data.session) {
          supabase.auth.signOut().then(() => {
            window.location.href = "/auth";
          });
        }
      });
      return;
    }

    // Ping visit tracker — fire-and-forget, silently no-ops if unauthenticated.
    // Count as a "login" bump only on the first ping per tab (fresh session).
    const isFreshSession = !sessionStorage.getItem("violet_visit_pinged");
    sessionStorage.setItem("violet_visit_pinged", "1");
    fetch("/api/track-visit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: isFreshSession }),
    }).catch(() => {});
  }, []);

  return null;
}
