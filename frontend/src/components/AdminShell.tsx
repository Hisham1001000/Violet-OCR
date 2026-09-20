"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

type Role = "admin" | "trainer";
type NavItem = { icon: string; label: string; href: string; roles: Role[] };

const NAV: NavItem[] = [
  { icon: "dashboard",          label: "Overview",       href: "/admin",               roles: ["admin"] },
  { icon: "people",             label: "Users",          href: "/admin/users",         roles: ["admin"] },
  { icon: "description",        label: "Documents",      href: "/admin/documents",     roles: ["admin"] },
  { icon: "school",             label: "Data Training",  href: "/admin/training",      roles: ["admin", "trainer"] },
  { icon: "account_balance_wallet", label: "Balances",   href: "/admin/subscriptions", roles: ["admin"] },
  { icon: "playlist_add_check", label: "Waitlist",       href: "/admin/waitlist",      roles: ["admin"] },
  { icon: "settings",           label: "System",         href: "/admin/system",        roles: ["admin"] },
  { icon: "history",            label: "Audit Log",      href: "/admin/audit-log",     roles: ["admin"] },
];

export function AdminShell({
  children,
  adminEmail,
  role = "admin",
}: {
  children: React.ReactNode;
  adminEmail: string;
  role?: Role;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);   // mobile drawer
  const visibleNav = NAV.filter((n) => n.roles.includes(role));
  const panelTitle = role === "trainer" ? "Trainer Panel" : "Admin Panel";

  function isActive(href: string) {
    if (href === "/admin") return pathname === "/admin";
    return pathname.startsWith(href);
  }

  // The sidebar contents — identical on desktop (fixed) and mobile (drawer).
  const SidebarInner = (
    <div className="flex flex-col h-full w-[220px] max-w-[82vw] bg-[#0f172a]">
      {/* Header */}
      <div className="px-4 pt-5 pb-4 border-b border-white/[0.06] flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-[10px] shrink-0 flex items-center justify-center text-[13px] font-bold text-white"
               style={{ background: "linear-gradient(135deg,#ef4444,#dc2626)" }}>A</div>
          <div>
            <div className="text-xs font-semibold text-slate-100 tracking-wide">{panelTitle}</div>
            <div className="text-[10px] text-slate-600 tracking-[0.06em] uppercase">
              {role === "trainer" ? "Data Labelling" : "Management"}
            </div>
          </div>
        </div>
        {/* Close (mobile only) */}
        <button onClick={() => setOpen(false)} className="lg:hidden text-slate-400 hover:text-white p-1" aria-label="Close menu">
          <span className="material-symbols-outlined" style={{ fontSize: 20 }}>close</span>
        </button>
      </div>

      {/* Nav */}
      <nav className="flex-1 p-2 flex flex-col gap-0.5 overflow-y-auto">
        {visibleNav.map((item) => {
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setOpen(false)}
              className={
                "flex items-center gap-2.5 px-2.5 py-2.5 rounded-[10px] no-underline text-[13px] transition-colors " +
                (active
                  ? "bg-white/[0.09] text-slate-100 font-semibold"
                  : "text-slate-500 hover:bg-white/[0.05] hover:text-slate-300")
              }
            >
              <span className="material-symbols-outlined shrink-0" style={{ fontSize: 18 }}>{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="px-2 pt-2 pb-4 border-t border-white/[0.06]">
        <Link
          href="/dashboard"
          onClick={() => setOpen(false)}
          className="flex items-center gap-2.5 px-2.5 py-2.5 rounded-[10px] no-underline text-[13px] text-slate-500 hover:text-slate-300 transition-colors"
        >
          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>arrow_back</span>
          Back to App
        </Link>
        <div className="px-2.5 py-1 text-[10px] text-slate-700 truncate">{adminEmail}</div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-100">
      {/* Mobile top bar with hamburger */}
      <header className="lg:hidden fixed top-0 inset-x-0 h-12 z-30 bg-[#0f172a] flex items-center justify-between px-2">
        <button onClick={() => setOpen(true)} className="text-slate-200 p-2" aria-label="Open menu">
          <span className="material-symbols-outlined" style={{ fontSize: 22 }}>menu</span>
        </button>
        <span className="text-slate-100 text-sm font-semibold">{panelTitle}</span>
        <span className="w-9" aria-hidden />
      </header>

      {/* Desktop fixed sidebar */}
      <aside className="hidden lg:block fixed left-0 top-0 bottom-0 z-40">{SidebarInner}</aside>

      {/* Mobile drawer + backdrop */}
      <div
        className={"lg:hidden fixed inset-0 bg-black/50 z-40 transition-opacity " + (open ? "opacity-100" : "opacity-0 pointer-events-none")}
        onClick={() => setOpen(false)}
        aria-hidden
      />
      <aside
        className={"lg:hidden fixed left-0 top-0 bottom-0 z-50 transition-transform duration-200 " + (open ? "translate-x-0" : "-translate-x-full")}
      >
        {SidebarInner}
      </aside>

      {/* Main content — full width on mobile (below the top bar), offset on desktop */}
      <main className="lg:ml-[220px] min-h-screen p-4 pt-16 sm:p-6 sm:pt-16 lg:p-7 lg:pt-7">
        {children}
      </main>
    </div>
  );
}
