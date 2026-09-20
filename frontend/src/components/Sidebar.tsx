"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect, CSSProperties } from "react";
import { createClient } from "@/lib/supabase/client";
import { useLang } from "@/lib/lang-context";
import { T } from "@/lib/translations";

// nav order: Dashboard → OCR Files → Billing → Settings → Support
const NAV_DEFS = [
  { icon: "dashboard",   key: "dashboard" as const, href: "/dashboard" },
  { icon: "description", key: "documents" as const, href: "/documents" },
  { icon: "credit_card", key: "billing"   as const, href: "/billing"   },
  { icon: "settings",    key: "settings"  as const, href: "/settings"  },
  { icon: "help",        key: "support"   as const, href: "/support"   },
];

interface SidebarProps {
  isMobile?: boolean;
  drawerOpen?: boolean;
  onCloseDrawer?: () => void;
}

function sidebarStyle(w: number, isRtl: boolean, mobile: boolean, open: boolean): CSSProperties {
  if (mobile) {
    // Mobile drawer: slides in from the start side, fixed full-height, overlays content.
    const hiddenTransform = isRtl ? "translateX(100%)" : "translateX(-100%)";
    return {
      position: "fixed",
      top: 0,
      bottom: 0,
      ...(isRtl ? { right: 0, left: "auto" } : { left: 0, right: "auto" }),
      zIndex: 60,
      display: "flex",
      flexDirection: "column",
      paddingTop: 20,
      paddingBottom: 16,
      background: "#0f0d12",
      borderRadius: 0,
      overflow: "hidden",
      width: 260,
      maxWidth: "82vw",
      transform: open ? "translateX(0)" : hiddenTransform,
      transition: "transform 0.25s ease-out",
      boxShadow: open ? "0 12px 60px rgba(0,0,0,0.55)" : "none",
    };
  }
  return {
    position: "fixed",
    ...(isRtl ? { right: 12, left: "auto" } : { left: 12, right: "auto" }),
    top: 12,
    bottom: 12,
    zIndex: 50,
    display: "flex",
    flexDirection: "column",
    paddingTop: 20,
    paddingBottom: 16,
    background: "#0f0d12",
    borderRadius: 16,
    overflow: "hidden",
    width: w,
    // Smooth, premium easing curve (Material-ish). Longer duration for a graceful feel.
    transition: "width 0.35s cubic-bezier(0.25, 0.8, 0.25, 1)",
    boxShadow: "0 8px 40px rgba(0,0,0,0.50), 0 2px 12px rgba(74,20,140,0.20), inset 0 1px 0 rgba(255,255,255,0.05)",
  };
}

// Shared premium easing for all sidebar animations — consistent, smooth feel.
const EASE = "cubic-bezier(0.25, 0.8, 0.25, 1)";
const DUR  = "0.4s";
// Fixed icon slot width — matches collapsed sidebar width (60px) so icons
// stay structurally centered without any justify-content transitions.
const ICON_SLOT = 44; // = 60px sidebar - 2*8px nav padding

const C = {
  nav: { flex: 1, padding: "0 8px", display: "flex", flexDirection: "column", gap: 4, flexShrink: 0 } as CSSProperties,
  // Nav link layout: icon lives in a fixed ICON_SLOT-wide slot, always centered
  // inside that slot. Padding/justify-content never change, so no snap glitches.
  navLink: (active: boolean): CSSProperties => ({
    display: "flex", alignItems: "center",
    justifyContent: "flex-start",
    gap: 0,
    padding: "10px 0",
    borderRadius: 12,
    textDecoration: "none",
    background: active ? "rgba(139,92,246,0.18)" : "transparent",
    transition: `background ${DUR} ${EASE}`,
    overflow: "hidden",
  }),
  // Icon slot — always ICON_SLOT px wide, icon centered inside. Matches the
  // collapsed sidebar exactly so nothing shifts when the sidebar grows.
  navIconSlot: {
    width: ICON_SLOT,
    flexShrink: 0,
    display: "flex", alignItems: "center", justifyContent: "center",
  } as CSSProperties,
  navIcon: (active: boolean): CSSProperties => ({
    color: active ? "#a78bfa" : "#64748b",
    fontSize: 17,
    transition: `color ${DUR} ${EASE}`,
  }),
  navLabel: (collapsed: boolean): CSSProperties => ({
    fontSize: 12, fontWeight: 500, color: "#cbd5e1", whiteSpace: "nowrap",
    overflow: "hidden",
    maxWidth: collapsed ? 0 : 140,
    opacity: collapsed ? 0 : 1,
    // Pad label a bit from icon when expanded; collapses to 0 cleanly.
    paddingInlineStart: collapsed ? 0 : 4,
    transition: `max-width ${DUR} ${EASE}, opacity ${DUR} ${EASE}, padding ${DUR} ${EASE}`,
  }),
  bottom: { padding: "0 8px", marginTop: "auto", flexShrink: 0 } as CSSProperties,
  accountExpanded: (show: boolean): CSSProperties => ({
    overflow: "hidden",
    maxHeight: show ? 80 : 0,
    opacity: show ? 1 : 0,
    transition: `max-height ${DUR} ${EASE}, opacity ${DUR} ${EASE}`,
    marginBottom: show ? 4 : 0,
  }),
  accountInner: {
    margin: "0 2px 0 2px",
    background: "rgba(255,255,255,0.05)",
    borderRadius: 10,
    padding: "10px 12px",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  } as CSSProperties,
  chipBtn: (): CSSProperties => ({
    width: "100%", display: "flex", alignItems: "center",
    justifyContent: "flex-start",
    gap: 0,
    padding: "8px 0",
    borderRadius: 12, border: "none", cursor: "pointer",
    background: "transparent",
    transition: `background ${DUR} ${EASE}`,
    overflow: "hidden",
  }),
  avatar: {
    width: 28, height: 28, borderRadius: "50%", flexShrink: 0,
    background: "rgba(139,92,246,0.2)",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 11, fontWeight: 700, color: "#a78bfa",
  } as CSSProperties,
};

export function Sidebar({ isMobile = false, drawerOpen = false, onCloseDrawer }: SidebarProps) {
  const pathname  = usePathname();
  const { lang }  = useLang();
  const isRtl     = lang === "ar";
  // Desktop: collapsed by default, expands on hover.
  // Mobile: always fully expanded when the drawer is open.
  const [hovered, setHovered]     = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [userEmail, setUserEmail] = useState("");

  const collapsed     = isMobile ? false : !hovered;
  const sidebarWidth  = collapsed ? 60 : 220;

  useEffect(() => {
    const sb = createClient();
    sb.auth.getUser().then(({ data }) => {
      if (data.user?.email) setUserEmail(data.user.email);
    });
  }, []);

  const userInitial = userEmail ? userEmail[0].toUpperCase() : null;

  function isActive(href: string) {
    if (href === "/dashboard") return pathname === "/dashboard" || pathname === "/";
    return pathname === href || pathname.startsWith(href + "/");
  }

  function handleNavClick() {
    if (isMobile) onCloseDrawer?.();
  }

  return (
    <>
      {/* Mobile backdrop */}
      {isMobile && (
        <div
          onClick={onCloseDrawer}
          aria-hidden
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15,13,18,0.55)",
            zIndex: 55,
            opacity: drawerOpen ? 1 : 0,
            pointerEvents: drawerOpen ? "auto" : "none",
            transition: "opacity 0.2s ease-out",
          }}
        />
      )}

      <aside
        style={sidebarStyle(sidebarWidth, isRtl, isMobile, drawerOpen)}
        onMouseEnter={() => !isMobile && setHovered(true)}
        onMouseLeave={() => { if (!isMobile) { setHovered(false); setAccountOpen(false); } }}
      >
        {/* Logo block — icon in a fixed slot (always centered), brand text slides out.
            NO overflow:hidden here — would clip the soft glow blur radius. */}
        <div
          style={{
            padding: "0 8px",
            marginBottom: 14,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            height: 40,
          }}
        >
          {/* Icon slot — fixed width. Icon shifts slightly right on hover for a
              gentle "entering toward you" feel. */}
          <div style={{
            width: ICON_SLOT,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            position: "relative",
          }}>
            {/* Ambient glow — always present. Soft, diffused, never overpowering. */}
            <div
              className="logo-glow"
              style={{
                opacity: collapsed ? 0.08 : 0.45,
                transform: collapsed
                  ? "translateX(0) scale(0.7)"
                  : "translateX(3px) scale(1.1)",
                animationPlayState: collapsed ? "paused" : "running",
                transition: `opacity ${DUR} ${EASE}, transform ${DUR} ${EASE}`,
              }}
            />
            <img
              src="/logo.png"
              alt="Violet"
              style={{
                position: "relative",
                // Sized to sit in the same visual weight as the 20 px nav icons —
                // collapsed state is only 2 px larger so the vertical rhythm reads
                // as one cohesive column; expanded grows gently to 26 px.
                width: collapsed ? 22 : 26,
                height: collapsed ? 22 : 26,
                objectFit: "contain",
                opacity: collapsed ? 0.55 : 1,
                transform: collapsed ? "translateX(0)" : "translateX(3px)",
                // Drop-shadow tuned softer: 4 px blur at 30 % purple feels like
                // light, not a halo ring.
                filter: collapsed
                  ? "drop-shadow(0 0 1px rgba(168,85,247,0.06)) saturate(0.6)"
                  : "drop-shadow(0 0 4px rgba(168,85,247,0.3)) saturate(1)",
                transition: [
                  `width ${DUR} ${EASE}`,
                  `height ${DUR} ${EASE}`,
                  `opacity ${DUR} ${EASE}`,
                  `filter ${DUR} ${EASE}`,
                  `transform ${DUR} ${EASE}`,
                ].join(", "),
              }}
            />
          </div>
          {/* Brand text — slides out from behind the icon slot, perfectly
              centered in the remaining space (icon stays aligned with nav icons) */}
          <div style={{
            overflow: "hidden",
            transition: `max-width ${DUR} ${EASE}, opacity ${DUR} ${EASE}`,
            maxWidth: collapsed ? 0 : 160,
            opacity: collapsed ? 0 : 1,
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}>
            <div style={{
              fontSize: 15, fontWeight: 800, whiteSpace: "nowrap",
              letterSpacing: "0.16em",
              background: "linear-gradient(135deg,#e879f9,#a855f7,#7c3aed)",
              WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
              textAlign: "center",
            }}>
              VIOLET
            </div>
          </div>
          {isMobile && (
            <button
              onClick={onCloseDrawer}
              aria-label="Close menu"
              style={{
                background: "rgba(255,255,255,0.06)", border: "none", cursor: "pointer",
                width: 30, height: 30, borderRadius: 8,
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "#cbd5e1",
              }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>close</span>
            </button>
          )}
        </div>

        {/* Nav */}
        <nav style={C.nav}>
          {NAV_DEFS.map((item) => {
            const active = isActive(item.href);
            const label  = T.nav[item.key][lang];
            return (
              <Link
                key={item.href}
                href={item.href}
                title={collapsed ? label : undefined}
                onClick={handleNavClick}
                style={C.navLink(active)}
                className="active:scale-95"
                onMouseEnter={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.05)"; }}
                onMouseLeave={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
              >
                <span style={C.navIconSlot}>
                  <span className="material-symbols-outlined" style={C.navIcon(active)}>{item.icon}</span>
                </span>
                <span style={C.navLabel(collapsed)}>{label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Bottom account */}
        <div style={C.bottom}>
          {/* Expanded panel */}
          <div style={C.accountExpanded(accountOpen && !collapsed)}>
            <div style={C.accountInner}>
              <div style={{ fontSize: 10, color: "#94a3b8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {userEmail || "—"}
              </div>
              <Link
                href="/settings"
                onClick={handleNavClick}
                style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#94a3b8", textDecoration: "none" }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "#e2e8f0"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "#94a3b8"; }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 12 }}>manage_accounts</span>
                {T.topbar.settingsLink[lang]}
              </Link>
            </div>
          </div>

          {/* Chip button — avatar lives in a fixed slot, text slides out beside it */}
          <button
            onClick={() => !collapsed && setAccountOpen(!accountOpen)}
            style={C.chipBtn()}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.06)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
          >
            <span style={C.navIconSlot}>
              <div style={C.avatar}>
                {userInitial ?? <span className="material-symbols-outlined" style={{ fontSize: 14 }}>person</span>}
              </div>
            </span>
            <div style={{
              overflow: "hidden",
              transition: `max-width ${DUR} ${EASE}, opacity ${DUR} ${EASE}`,
              maxWidth: collapsed ? 0 : 120,
              opacity: collapsed ? 0 : 1,
              flex: 1,
              textAlign: isRtl ? "right" : "left",
            }}>
              <div style={{ fontSize: 11, color: "#cbd5e1", fontWeight: 500, whiteSpace: "nowrap" }}>{T.nav.myAccount[lang]}</div>
            </div>
            <span
              className="material-symbols-outlined"
              style={{
                fontSize: 14, color: "#475569",
                transition: `max-width ${DUR} ${EASE}, opacity ${DUR} ${EASE}, transform ${DUR} ${EASE}`,
                maxWidth: collapsed ? 0 : 20,
                opacity: collapsed ? 0 : 1,
                transform: accountOpen ? "rotate(180deg)" : "rotate(0deg)",
                marginInlineEnd: collapsed ? 0 : 8,
              }}
            >
              expand_less
            </span>
          </button>
        </div>
      </aside>
    </>
  );
}
