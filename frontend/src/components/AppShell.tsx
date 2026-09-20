"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";
import { useLang } from "@/lib/lang-context";
import { T } from "@/lib/translations";

interface AppShellProps {
  children: React.ReactNode;
  /** Rarely needed — the title is derived from the route by default. */
  title?: string;
}

// The shell is a layout now, so it cannot take a title prop from the page.
// Longest match wins, so /documents/<id> resolves before /documents.
function routeTitle(pathname: string, lang: "en" | "ar"): string {
  if (pathname.startsWith("/documents/")) return T.docDetail.ocrDashboard[lang];
  if (pathname.startsWith("/documents"))  return T.docList.title[lang];
  if (pathname.startsWith("/dashboard"))  return T.dashboard.title[lang];
  if (pathname.startsWith("/settings"))   return T.settings.title[lang];
  if (pathname.startsWith("/billing"))    return lang === "ar" ? "الرصيد" : "Balance";
  if (pathname.startsWith("/support"))    return lang === "ar" ? "الدعم"  : "Support";
  return "Violet";
}

// Matches Tailwind's `md` breakpoint.
const MOBILE_BREAKPOINT = 768;

export function AppShell({ children, title }: AppShellProps) {
  const { lang }  = useLang();
  const isRtl     = lang === "ar";
  const pathname  = usePathname();
  const heading   = title ?? routeTitle(pathname ?? "", lang);

  const [isMobile, setIsMobile] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Close drawer on route-like events (navigation inside the drawer).
  useEffect(() => {
    if (!drawerOpen) return;
    // Prevent body scroll while drawer is open on mobile.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [drawerOpen]);

  // Desktop: fixed 80px inset (60 + 12 + 8). Mobile: full width, drawer overlays.
  const marginValue = isMobile ? 0 : 80;

  const contentStyle = isRtl
    ? { marginRight: marginValue, marginLeft: 0,   transition: "margin 0.2s ease-out" }
    : { marginLeft:  marginValue, marginRight: 0,  transition: "margin 0.2s ease-out" };

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar
        isMobile={isMobile}
        drawerOpen={drawerOpen}
        onCloseDrawer={() => setDrawerOpen(false)}
      />
      <div style={contentStyle} className="flex flex-col w-full min-h-screen">
        <TopBar
          title={heading}
          showMobileMenu={isMobile}
          onOpenMobileMenu={() => setDrawerOpen(true)}
        />
        <main className="flex-1 p-4 sm:p-5 md:p-7">
          {children}
        </main>
      </div>
    </div>
  );
}
