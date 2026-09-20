import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AdminShell } from "@/components/AdminShell";

// Server Component — runs on every /admin/* request.
// Allows full admins (everywhere) and trainers (training section only).
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  let user;
  let profile;

  try {
    const supabase = createClient();
    const { data } = await supabase.auth.getUser();
    user = data?.user;

    if (!user) {
      redirect("/auth?next=/admin");
    }

    const { data: profileData } = await supabase
      .from("user_profiles")
      .select("is_admin, is_trainer, email")
      .eq("user_id", user.id)
      .single();
    profile = profileData;
  } catch (e: unknown) {
    if (e && typeof e === "object" && "digest" in e) throw e;
    redirect("/auth?next=/admin");
  }

  const isAdmin   = !!profile?.is_admin;
  const isTrainer = !!profile?.is_trainer;

  // No role at all → out
  if (!isAdmin && !isTrainer) {
    redirect("/dashboard");
  }
  // Trainer-only users land on the training page by default.
  // (The AdminShell hides every other section for trainers.)

  return (
    <AdminShell
      adminEmail={profile?.email ?? user.email ?? ""}
      role={isAdmin ? "admin" : "trainer"}
    >
      {children}
    </AdminShell>
  );
}
