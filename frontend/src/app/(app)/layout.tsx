import { AppShell } from "@/components/AppShell";
import { SessionGuard } from "@/components/SessionGuard";
import { GuestClaim } from "@/components/GuestClaim";

// The signed-in shell — sidebar and top bar — for every page in this group.
//
// It used to be rendered INSIDE each page component. In the App Router that
// means it unmounts and remounts on every navigation, so each page change
// re-ran TopBar's effects and refetched /api/usage (measured avg 1098ms) and
// /api/documents (median 2006ms) for data that had not changed. Two to three
// seconds of the same requests, on every click.
//
// As a layout it mounts once and survives navigation: the chrome stays put, its
// data is fetched once per session, and only the page body swaps.
//
// `(app)` is a route group — the parentheses keep it out of the URL, so these
// pages are still /dashboard, /billing and so on. /auth, /pricing and /policy
// sit outside it deliberately: they must not have the shell.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SessionGuard />
      <GuestClaim />
      <AppShell>{children}</AppShell>
    </>
  );
}
