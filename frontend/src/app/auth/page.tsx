"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useLang } from "@/lib/lang-context";
import { siteUrl } from "@/lib/site-url";
import { GoogleOneTap } from "@/components/GoogleOneTap";

const tx = (en: string, ar: string) => ({ en, ar });
const C = {
  tabIn:     tx("Sign In",              "دخول"),
  tabUp:     tx("Sign Up",              "تسجيل"),
  h1In:      tx("Welcome back to",      "مرحباً بعودتك إلى"),
  h1Up:      tx("Create your",          "أنشئ حسابك في"),
  h1Forgot:  tx("Reset password",       "استعادة كلمة المرور"),
  subIn:     tx("Sign in to continue",  "سجّل دخولك للمتابعة"),
  subUp:     tx("Start for free today", "ابدأ مجاناً اليوم"),
  subForgot: tx("Enter your email and we'll send a reset link", "أدخل بريدك وسنرسل رابط الاستعادة"),
  lName:     tx("Full Name",            "الاسم الكامل"),
  lEmail:    tx("Email",                "البريد الإلكتروني"),
  lPw:       tx("Password",             "كلمة المرور"),
  lCf:       tx("Confirm Password",     "تأكيد كلمة المرور"),
  phName:    tx("Your full name",       "اسمك الكامل"),
  phEmail:   tx("you@example.com",      "example@mail.com"),
  phPw:      tx("Min. 6 characters",    "٦ أحرف على الأقل"),
  forgot:    tx("Forgot password?",     "نسيت كلمة المرور؟"),
  remember:  tx("Remember me",          "تذكّرني"),
  terms1:    tx("I agree to the",       "أوافق على"),
  termsA:    tx("Terms",                "الشروط"),
  terms2:    tx("and",                  "و"),
  termsB:    tx("Privacy Policy",       "سياسة الخصوصية"),
  btnIn:     tx("Sign In",              "تسجيل الدخول"),
  btnUp:     tx("Create Account",       "إنشاء الحساب"),
  btnReset:  tx("Send Reset Link",      "إرسال الرابط"),
  btnLoad:   tx("Loading…",             "جارٍ…"),
  orWith:    tx("or",                   "أو"),
  noAcct:    tx("Don't have an account?", "ليس لديك حساب؟"),
  goUp:      tx("Sign up",              "سجّل الآن"),
  haveAcct:  tx("Already have an account?", "لديك حساب؟"),
  goIn:      tx("Sign in",              "تسجيل الدخول"),
  backIn:    tx("← Back to sign in",   "→ العودة للدخول"),
  resetOk:   tx("Reset link sent to",   "تم إرسال الرابط إلى"),
  created:   tx("Account created — sign in now.", "تم الإنشاء — سجّل الدخول."),
  verifyTitle: tx("Check your email",       "تحقق من بريدك"),
  verifyBody1: tx("We sent a verification link to", "أرسلنا رابط التفعيل إلى"),
  verifyBody2: tx("Click the link to activate your account, then sign in.", "اضغط الرابط لتفعيل الحساب ثم سجّل الدخول."),
  // Deliberately worded as an instruction, not a fallback. Without an
  // authenticated sending domain the message reliably lands in spam, so
  // "check there if you don't see it" sets the wrong expectation.
  verifyHint:  tx("Check your spam folder — the email usually arrives there.",
                  "تحقق من مجلد الرسائل غير المرغوب فيها (Spam) — عادةً تصل الرسالة هناك."),
  resendBtn:   tx("Resend verification email",  "إعادة إرسال رابط التفعيل"),
  resendWait:  tx("Resend in",                  "إعادة الإرسال خلال"),
  resendOk:    tx("Verification email sent again — check your inbox.",
                  "تم إعادة إرسال الرابط — تحقق من بريدك."),
  resendSec:   tx("s",                          "ث"),
  errMatch:  tx("Passwords don't match.", "كلمتا المرور غير متطابقتين."),
  errWeak:   tx("Password is too weak.", "كلمة المرور ضعيفة جداً."),
  errTerms:  tx("Please agree to the Terms.", "يجب الموافقة على الشروط."),
  errName:   tx("Full name is required.", "الاسم الكامل مطلوب."),
  errEmail:  tx("Email is required.",    "البريد الإلكتروني مطلوب."),
  errExists: tx("This email already has an account. Try signing in instead.", "هذا البريد مسجّل بالفعل. حاول تسجيل الدخول."),
  errEmailFmt: tx("Please enter a valid email address.", "يرجى إدخال بريد إلكتروني صحيح."),
  didMean:    tx("Did you mean",                  "هل تقصد"),
  useSuggest: tx("Use suggestion",                "استخدم الاقتراح"),
  tagline:   tx("Intelligent Arabic OCR — built for precision.", "تقنية OCR عربية ذكية — مصممة للدقة."),
  feat1:     tx("Extract structured data from Arabic documents", "استخراج بيانات منظّمة من المستندات العربية"),
  feat2:     tx("Export to Excel instantly",                     "تصدير فوري إلى Excel"),
  feat3:     tx("Secure Document Processing",                   "معالجة آمنة للمستندات"),
  s1: tx("Weak","ضعيفة"), s2: tx("Fair","مقبولة"),
  s3: tx("Good","جيدة"),  s4: tx("Strong","قوية"),
};
type L = "en"|"ar";

// Strict email format check — RFC-light; matches what real mail servers accept
const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

// Common email-domain typos → real domain.
// Caught BEFORE submission so users don't lose their verification email
// to a nonexistent domain (e.g. gnail.com).
const DOMAIN_TYPOS: Record<string, string> = {
  // gmail
  "gnail.com": "gmail.com",
  "gmial.com": "gmail.com",
  "gmaill.com": "gmail.com",
  "gmail.co": "gmail.com",
  "gmail.cm": "gmail.com",
  "gmail.con": "gmail.com",
  "gmail.om": "gmail.com",
  "gamil.com": "gmail.com",
  "gmal.com": "gmail.com",
  "gmali.com": "gmail.com",
  "gmaol.com": "gmail.com",
  // yahoo
  "yaho.com": "yahoo.com",
  "yahooo.com": "yahoo.com",
  "yahoo.co": "yahoo.com",
  "yahoo.cm": "yahoo.com",
  "yahoo.con": "yahoo.com",
  "yhoo.com": "yahoo.com",
  // hotmail
  "hotmial.com": "hotmail.com",
  "hotnail.com": "hotmail.com",
  "hotmai.com": "hotmail.com",
  "hotmail.co": "hotmail.com",
  "hotmail.cm": "hotmail.com",
  "hotmail.con": "hotmail.com",
  "hotmaill.com": "hotmail.com",
  // outlook
  "outlok.com": "outlook.com",
  "outloook.com": "outlook.com",
  "outlook.co": "outlook.com",
  "outlook.cm": "outlook.com",
  "outlook.con": "outlook.com",
  // icloud
  "iclod.com": "icloud.com",
  "icoud.com": "icloud.com",
  "icloud.co": "icloud.com",
};

function suggestEmail(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 1) return null;
  const local  = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  const fix = DOMAIN_TYPOS[domain];
  return fix ? `${local}@${fix}` : null;
}

function pwStr(pw: string): 0|1|2|3|4 {
  if (!pw) return 0;
  let s = 0;
  if (pw.length >= 6)  s++;
  if (pw.length >= 10) s++;
  if (/[0-9]/.test(pw) && /[a-zA-Z]/.test(pw)) s++;
  if (/[^a-zA-Z0-9]/.test(pw)) s++;
  return Math.min(s, 4) as 0|1|2|3|4;
}
const SC = ["","#ef4444","#f97316","#eab308","#22c55e"];
function sLbl(s: number, l: L): string {
  return (["", C.s1[l], C.s2[l], C.s3[l], C.s4[l]] as string[])[s] ?? "";
}
function Bar({ pw, lang }: { pw: string; lang: L }) {
  const s = pwStr(pw);
  if (!pw) return null;
  return (
    <div style={{ marginTop: 5, display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ flex: 1, display: "flex", gap: 3 }}>
        {[1,2,3,4].map(i => (
          <div key={i} style={{ flex:1, height:3, borderRadius:99, background: i<=s ? SC[s] : "#e2e8f0", transition:"background .25s" }} />
        ))}
      </div>
      <span style={{ fontSize:10, color:SC[s], fontWeight:600, whiteSpace:"nowrap" }}>{sLbl(s,lang)}</span>
    </div>
  );
}

function EyeIcon({ open }: { open: boolean }) {
  return open ? (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
      <line x1="1" y1="1" x2="23" y2="23"/>
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  );
}

type Mode = "signin"|"signup"|"forgot";

export default function AuthPage() {
  const { lang } = useLang();
  const isRtl = lang === "ar";
  const t = (k: keyof typeof C) => C[k][lang];

  const [mode, setMode]           = useState<Mode>("signin");

  // Every CTA on the landing page means "create an account", so it links to
  // /auth?mode=signup. Read after mount rather than in the initial state: this
  // file has bitten us with a hydration mismatch before, and a brief flash of
  // the sign-in tab is a far cheaper failure than a hydration error on the one
  // page every new customer has to get through.
  useEffect(() => {
    const m = new URLSearchParams(window.location.search).get("mode");
    if (m === "signup" || m === "forgot") setMode(m);
  }, []);
  const [animKey, setAnimKey]     = useState(0);
  const [animDir, setAnimDir]     = useState<"fwd"|"bwd">("fwd");
  const MODE_ORDER: Mode[]        = ["signin","signup","forgot"];
  const [fullName, setFullName]   = useState("");
  const [email, setEmail]         = useState("");
  const [pw, setPw]               = useState("");
  const [cf, setCf]               = useState("");
  const [remember, setRemember]   = useState(true);
  const [agreed, setAgreed]       = useState(false);
  const [showPw, setShowPw]       = useState(false);
  const [showCf, setShowCf]       = useState(false);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState<string|null>(null);
  const [info, setInfo]               = useState<string|null>(null);
  const [resetSent, setResetSent]     = useState(false);
  const [signupSent, setSignupSent]   = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [accountStatus, setAccountStatus] = useState<"banned" | null>(null);
  const [resendLoading, setResendLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resendInfo, setResendInfo] = useState<string | null>(null);
  const [emailNotConfirmed, setEmailNotConfirmed] = useState(false);
  const [googleReady, setGoogleReady] = useState(false);

  // Resend cooldown ticker
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const id = setInterval(() => setResendCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [resendCooldown]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const p = new URLSearchParams(window.location.search);
    if (p.get("banned")) setAccountStatus("banned");

    // A failed sign-in landed here with ?error=... and the page said nothing at
    // all. Clarity caught someone sitting on exactly that, retrying.
    if (p.get("error")) {
      const reason = p.get("reason");
      setError(
        reason === "other_browser"
          ? "افتح الرابط في المتصفح نفسه الذي سجّلت منه، أو سجّل الدخول من هنا مباشرة. — Open the link in the browser you signed up in, or just sign in here."
          : reason === "expired"
          ? "انتهت صلاحية الرابط أو استُخدم من قبل. سجّل الدخول من هنا. — That link has expired or was already used. Please sign in here."
          : "تعذّر إكمال تسجيل الدخول. حاول مرة أخرى. — Sign-in could not be completed. Please try again.",
      );
    }
  }, []);

  const sb = createClient();

  function go(m: Mode) {
    const curIdx = MODE_ORDER.indexOf(mode);
    const nxtIdx = MODE_ORDER.indexOf(m);
    setAnimDir(nxtIdx >= curIdx ? "fwd" : "bwd");
    setAnimKey(k => k + 1);
    setMode(m); setError(null); setInfo(null);
    setPw(""); setCf(""); setShowPw(false); setShowCf(false);
    setResetSent(false); setSignupSent(false); setEmailNotConfirmed(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(null); setInfo(null);
    // Strict email format check — applies to all modes (signin/signup/forgot)
    const trimmedEmail = email.trim();
    if (!trimmedEmail) { setError(t("errEmail")); return; }
    if (!EMAIL_RE.test(trimmedEmail)) { setError(t("errEmailFmt")); return; }
    // Block known-typo domains (e.g. gnail.com) — surface suggestion instead
    if (suggestEmail(trimmedEmail)) {
      setError(t("errEmailFmt"));
      return;
    }
    if (mode === "forgot") {
      setLoading(true);
      const { error } = await sb.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${siteUrl()}/auth/reset`,
      });
      setLoading(false);
      if (error) setError(error.message); else setResetSent(true);
      return;
    }
    if (mode === "signup") {
      if (!fullName.trim())  { setError(t("errName")); return; }
      if (pw !== cf)         { setError(t("errMatch")); return; }
      if (!agreed)           { setError(t("errTerms")); return; }
      if (pwStr(pw) < 2)     { setError(t("errWeak")); return; }
    }
    setLoading(true);
    if (mode === "signup") {
      const { data, error } = await sb.auth.signUp({
        email: email.trim(), password: pw,
        options: {
          data: { full_name: fullName.trim() },
          emailRedirectTo: `${siteUrl()}/auth/callback`,
        },
      });
      // Supabase returns an empty identities array when the email already
      // exists — detect this and steer the user to sign in instead.
      if (error) setError(error.message);
      else if (data.user && data.user.identities && data.user.identities.length === 0) {
        setError(t("errExists"));
      }
      else {
        setSignupSent(true);
        // Meta learns from this which visitors become accounts
        (window as unknown as { fbq?: (...a: unknown[]) => void }).fbq?.("track", "CompleteRegistration", { method: "email" });
      }
    } else {
      const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password: pw });
      if (error) {
        // Detect "email not confirmed" errors (Supabase may return various messages)
        if (error.message?.toLowerCase().includes("email not confirmed") ||
            error.message?.toLowerCase().includes("user not confirmed")) {
          setEmailNotConfirmed(true);
        } else {
          setError(error.message);
        }
      }
      else {
        if (remember) localStorage.setItem("violet_remember","1");
        else { localStorage.removeItem("violet_remember"); sessionStorage.setItem("violet_session","1"); }
        setTransitioning(true);
        setTimeout(() => { window.location.href = "/dashboard"; }, 320);
        return;
      }
    }
    setLoading(false);
  }

  async function resendVerification() {
    if (!email.trim() || resendLoading || resendCooldown > 0) return;
    setResendLoading(true); setResendInfo(null); setError(null);
    const { error } = await sb.auth.resend({
      type: "signup",
      email: email.trim(),
      options: { emailRedirectTo: `${siteUrl()}/auth/callback` },
    });
    setResendLoading(false);
    if (error) {
      setError(error.message);
    } else {
      setResendInfo(t("resendOk"));
      setResendCooldown(60);
    }
  }

  async function oauth(p: "google"|"azure") {
    // Set the flag BEFORE leaving for Google. Coming back, the session exists
    // but this browser has never had the flag -- and SessionGuard reads exactly
    // that as "a leftover session from a closed browser" and signs the person
    // straight out again. Signing in with Google means remembering, the same as
    // ticking the box, so record it here as well as in /auth/session-init.
    localStorage.setItem("violet_remember", "1");
    await sb.auth.signInWithOAuth({
      provider: p,
      options: {
        redirectTo: `${siteUrl()}/auth/callback`,
        // Show the accounts already signed in on this device instead of an
        // empty "email or phone" box. Without it Google decides, and for
        // anyone with more than one account -- or none in this browser -- that
        // decision is a typed password, which is where people give up.
        ...(p === "google" ? { queryParams: { prompt: "select_account" } } : {}),
        ...(p==="azure" ? { scopes:"email profile" } : {}),
      },
    });
  }

  /* ── form styles ── */
  const inp: React.CSSProperties = {
    width:"100%", boxSizing:"border-box",
    background:"#f8fafc", border:"1.5px solid #e2e8f0",
    borderRadius:10, padding:"11px 14px", paddingInlineEnd:40,
    fontSize:14, color:"#0f172a",
    outline:"none", fontFamily:"inherit",
    transition:"border-color .15s, box-shadow .15s",
    direction: isRtl ? "rtl" : "ltr",
  };
  const onFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    e.target.style.borderColor="#7c3aed";
    e.target.style.boxShadow="0 0 0 3px rgba(124,58,237,0.10)";
    e.target.style.background="#fff";
  };
  const onBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    e.target.style.borderColor="#e2e8f0";
    e.target.style.boxShadow="none";
    e.target.style.background="#f8fafc";
  };
  const eyeBtn: React.CSSProperties = {
    position:"absolute", top:"50%", transform:"translateY(-50%)",
    insetInlineEnd:0, width:44, height:44,
    display:"flex", alignItems:"center", justifyContent:"center",
    background:"none", border:"none", cursor:"pointer",
    color:"#94a3b8", fontSize:14, padding:0, lineHeight:1,
  };
  const lbl: React.CSSProperties = {
    display:"block", fontSize:12.5, fontWeight:600,
    color:"#64748b", marginBottom:4,
  };
  const chk = (on: boolean): React.CSSProperties => ({
    width:16, height:16, borderRadius:5, flexShrink:0,
    border:`1.5px solid ${on ? "#7c3aed" : "#cbd5e1"}`,
    background: on ? "#7c3aed" : "#fff",
    display:"flex", alignItems:"center", justifyContent:"center",
    transition:"all .15s", cursor:"pointer",
  });

  return (
    <div
      dir={isRtl ? "rtl" : "ltr"}
      className="auth-page"
      style={{
        position:"relative", minHeight:"100dvh", overflow:"hidden",
        background:"#fff", fontFamily:"'Inter','Alexandria',sans-serif",
        display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
        padding:"max(12px, env(safe-area-inset-top)) 16px max(12px, env(safe-area-inset-bottom))",
      }}
    >
      {/* Background: thin concentric rings -- the same line motif as the
          landing page hero, so the site and the sign-in page read as one
          product. Decorative only. */}
      <div aria-hidden className="auth-rings">
        {[1, 2, 3, 4].map(i => <span key={i} className={`auth-ring auth-ring-${i}`} />)}
      </div>


      {/* The card: one centred column holding the tabs and the form */}
      <div className="auth-card" style={{
        position:"relative", zIndex:1, width:"100%", maxWidth:420,
        background:"#fff", border:"1px solid #E8EAF1", borderRadius:20,
        padding:"16px 24px 18px",
        boxShadow:"0 1px 2px rgba(19,32,67,0.04), 0 18px 48px rgba(19,32,67,0.08)",
        animation: "auth-panel-in 0.35s cubic-bezier(0.16,1,0.3,1) both",
        transition: "opacity 0.28s ease, transform 0.28s ease",
        opacity: transitioning ? 0 : 1,
        transform: transitioning ? "translateY(-10px)" : "translateY(0)",
      }}>
        <div style={{ width:"100%" }}>

          {/* Tabs — fixed outside animation wrapper so the indicator slides
              smoothly via CSS transition without the bar itself re-mounting */}
          {mode !== "forgot" && (
            <div style={{ display:"flex", borderBottom:"2px solid #f1f5f9", marginBottom:12 }}>
              {(["signin","signup"] as const).map(tab => (
                <button key={tab} onClick={() => go(tab)} style={{
                  flex:1, padding:"11px 0", border:"none", background:"transparent",
                  cursor:"pointer", fontSize:13, fontWeight:600, fontFamily:"inherit",
                  color: mode===tab ? "#7c3aed" : "#94a3b8",
                  borderBottom: mode===tab ? "2px solid #7c3aed" : "2px solid transparent",
                  marginBottom:"-2px", transition:"color 0.18s, border-color 0.18s",
                }}>
                  {tab==="signin" ? t("tabIn") : t("tabUp")}
                </button>
              ))}
            </div>
          )}

          {/* Directional slide wrapper — re-mounts on every tab switch via animKey,
              slides from the right when going forward and from the left going back */}
          <div
            key={animKey}
            style={{ animation: `form-slide-${animDir} 0.24s cubic-bezier(0.16,1,0.3,1) both` }}
          >

          {/* Heading */}
          <div style={{ marginBottom:12, textAlign:"center" }}>
            {mode === "forgot" ? (
              <>
                <h1 style={{ fontSize:21, fontWeight:800, color:"#132043", margin:"0 0 2px", letterSpacing:"-0.02em" }}>
                  {t("h1Forgot")}
                </h1>
                <p style={{ fontSize:13, color:"#94a3b8", margin:0 }}>{t("subForgot")}</p>
              </>
            ) : (
              <>
                <h1 style={{ fontSize:21, fontWeight:800, color:"#132043", margin:"0 0 2px", letterSpacing:"-0.02em", lineHeight:1.2 }}>
                  {mode==="signin" ? t("h1In") : t("h1Up")}{" "}
                  <span style={{ background:"linear-gradient(135deg,#9333ea,#7c3aed)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent", fontWeight:800 }}>
                    {"Violet"}
                  </span>
                  {mode==="signup" && lang==="en" && <span style={{ color:"#132043" }}> account</span>}
                </h1>
                <p style={{ fontSize:13, color:"#94a3b8", margin:0 }}>
                  {mode==="signin" ? t("subIn") : t("subUp")}
                </p>
              </>
            )}
          </div>

          {/* Reset sent */}
          {mode==="forgot" && resetSent ? (
            <div>
              <div style={{ background:"#f0fdf4", border:"1.5px solid #bbf7d0", borderRadius:12, padding:"16px", fontSize:13, color:"#15803d", lineHeight:1.6 }}>
                ✓ {t("resetOk")} <strong>{email}</strong>
              </div>
              <button onClick={() => go("signin")} style={{ marginTop:18, background:"none", border:"none", cursor:"pointer", color:"#7c3aed", fontWeight:600, fontSize:13, fontFamily:"inherit", padding:0 }}>
                {t("backIn")}
              </button>
            </div>
          ) : mode==="signup" && signupSent ? (
            <div>
              <div style={{ background:"#f5f3ff", border:"1.5px solid #ddd6fe", borderRadius:12, padding:"18px", lineHeight:1.6 }}>
                <div style={{ fontSize:15, fontWeight:700, color:"#6d28d9", marginBottom:8 }}>
                  ✉️ {t("verifyTitle")}
                </div>
                <div style={{ fontSize:13, color:"#4c1d95" }}>
                  {t("verifyBody1")} <strong>{email}</strong>.
                </div>
                <div style={{ fontSize:13, color:"#4c1d95", marginTop:6 }}>
                  {t("verifyBody2")}
                </div>
                <div style={{
                  fontSize:13, fontWeight:600, color:"#6d28d9", marginTop:12,
                  background:"#ede9fe", border:"1px solid #ddd6fe",
                  borderRadius:8, padding:"9px 11px",
                }}>
                  📁 {t("verifyHint")}
                </div>
              </div>

              <button
                type="button"
                onClick={resendVerification}
                disabled={resendLoading || resendCooldown > 0}
                style={{
                  marginTop:14, width:"100%", padding:"11px", borderRadius:10,
                  border:"1.5px solid #ddd6fe",
                  background: resendCooldown > 0 ? "#faf5ff" : "#fff",
                  color:"#7c3aed", fontWeight:600, fontSize:12,
                  fontFamily:"inherit",
                  cursor: (resendLoading || resendCooldown > 0) ? "default" : "pointer",
                  opacity: (resendLoading || resendCooldown > 0) ? 0.55 : 1,
                  transition:"all .15s",
                }}
              >
                {resendLoading
                  ? t("btnLoad")
                  : resendCooldown > 0
                    ? `${t("resendWait")} ${resendCooldown}${t("resendSec")}`
                    : `✉️  ${t("resendBtn")}`}
              </button>

              {resendInfo && (
                <div style={{ marginTop:10, background:"#f0fdf4", border:"1.5px solid #bbf7d0", borderRadius:10, padding:"9px 12px", fontSize:12, color:"#16a34a" }}>
                  ✓ {resendInfo}
                </div>
              )}

              <button onClick={() => go("signin")} style={{ marginTop:18, background:"none", border:"none", cursor:"pointer", color:"#7c3aed", fontWeight:600, fontSize:13, fontFamily:"inherit", padding:0 }}>
                {t("backIn")}
              </button>
            </div>
          ) : mode==="signin" && emailNotConfirmed ? (
            <div>
              <div style={{ background:"#f5f3ff", border:"1.5px solid #ddd6fe", borderRadius:12, padding:"18px", lineHeight:1.6 }}>
                <div style={{ fontSize:15, fontWeight:700, color:"#6d28d9", marginBottom:8 }}>
                  ✉️ {t("verifyTitle")}
                </div>
                <div style={{ fontSize:13, color:"#4c1d95" }}>
                  {lang === "ar"
                    ? "لم نتمكن من تسجيل دخولك. تحتاج إلى تأكيد بريدك أولاً."
                    : "We couldn't sign you in. Please verify your email first."}
                </div>
                <div style={{ fontSize:13, color:"#4c1d95", marginTop:6 }}>
                  {t("verifyBody1")} <strong>{email}</strong>.{" "}
                  {t("verifyBody2")}
                </div>
                <div style={{
                  fontSize:13, fontWeight:600, color:"#6d28d9", marginTop:12,
                  background:"#ede9fe", border:"1px solid #ddd6fe",
                  borderRadius:8, padding:"9px 11px",
                }}>
                  📁 {t("verifyHint")}
                </div>
              </div>

              <button
                type="button"
                onClick={resendVerification}
                disabled={resendLoading || resendCooldown > 0}
                style={{
                  marginTop:14, width:"100%", padding:"11px", borderRadius:10,
                  border:"1.5px solid #ddd6fe",
                  background: resendCooldown > 0 ? "#faf5ff" : "#fff",
                  color:"#7c3aed", fontWeight:600, fontSize:12,
                  fontFamily:"inherit",
                  cursor: (resendLoading || resendCooldown > 0) ? "default" : "pointer",
                  opacity: (resendLoading || resendCooldown > 0) ? 0.55 : 1,
                  transition:"all .15s",
                }}
              >
                {resendLoading
                  ? t("btnLoad")
                  : resendCooldown > 0
                    ? `${t("resendWait")} ${resendCooldown}${t("resendSec")}`
                    : `✉️  ${t("resendBtn")}`}
              </button>

              {resendInfo && (
                <div style={{ marginTop:10, background:"#f0fdf4", border:"1.5px solid #bbf7d0", borderRadius:10, padding:"9px 12px", fontSize:12, color:"#16a34a" }}>
                  ✓ {resendInfo}
                </div>
              )}

              <button onClick={() => setEmailNotConfirmed(false)} style={{ marginTop:18, background:"none", border:"none", cursor:"pointer", color:"#7c3aed", fontWeight:600, fontSize:13, fontFamily:"inherit", padding:0 }}>
                {t("backIn")}
              </button>
            </div>
          ) : (
            <form onSubmit={submit} style={{ display:"flex", flexDirection:"column", gap:10 }}>

              {mode==="signup" && (
                <div>
                  <label htmlFor="auth-name" style={lbl}>{t("lName")}</label>
                  <input id="auth-name" className="auth-input" type="text" autoComplete="name" autoCapitalize="words" value={fullName} onChange={e => setFullName(e.target.value)}
                    required placeholder={t("phName")} style={{...inp, paddingInlineEnd:14}}
                    onFocus={onFocus} onBlur={onBlur} />
                </div>
              )}

              <div>
                <label htmlFor="auth-email" style={lbl}>{t("lEmail")}</label>
                <input id="auth-email" className="auth-input" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={email} onChange={e => setEmail(e.target.value)}
                  required placeholder={t("phEmail")} style={{...inp, paddingInlineEnd:14, direction:"ltr", textAlign: isRtl ? "right" : "left"}}
                  onFocus={onFocus} onBlur={onBlur} />
                {(() => {
                  const sug = suggestEmail(email.trim());
                  if (!sug) return null;
                  return (
                    <p style={{fontSize:11, color:"#7c3aed", marginTop:6, display:"flex", alignItems:"center", gap:6, flexWrap:"wrap"}}>
                      <span>{t("didMean")}</span>
                      <button
                        type="button"
                        onClick={() => setEmail(sug)}
                        style={{
                          background:"none", border:"none", padding:0, cursor:"pointer",
                          color:"#6d28d9", fontWeight:700, fontFamily:"inherit", fontSize:11,
                          textDecoration:"underline",
                        }}
                        aria-label={t("useSuggest")}
                      >
                        {sug}
                      </button>
                      <span>?</span>
                    </p>
                  );
                })()}
              </div>

              {mode !== "forgot" && (
                // on sign-up the two password fields share a row on wider screens, which is
                // what lets the whole form -- Google button included -- fit a laptop screen
                <div className={mode==="signup" ? "auth-pw-pair" : undefined}>
                <div>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4 }}>
                    <label htmlFor="auth-pw" style={{...lbl, marginBottom:0}}>{t("lPw")}</label>
                    {mode==="signin" && (
                      <button type="button" onClick={() => go("forgot")}
                        style={{ background:"none", border:"none", cursor:"pointer", fontSize:12.5, color:"#7c3aed", fontFamily:"inherit", fontWeight:500, padding:"14px 0", paddingInlineStart:16, margin:"-14px 0" }}>
                        {t("forgot")}
                      </button>
                    )}
                  </div>
                  <div style={{ position:"relative" }}>
                    <input id="auth-pw" className="auth-input" autoComplete={mode==="signup" ? "new-password" : "current-password"} type={showPw?"text":"password"} value={pw} onChange={e => setPw(e.target.value)}
                      required minLength={6} placeholder={t("phPw")}
                      style={{...inp, letterSpacing: showPw?"normal":"0.06em"}}
                      onFocus={onFocus} onBlur={onBlur} />
                    <button type="button" style={eyeBtn} onClick={() => setShowPw(v=>!v)} aria-label={showPw ? "Hide password" : "Show password"}>
                      <EyeIcon open={showPw} />
                    </button>
                  </div>
                  {mode==="signup" && <Bar pw={pw} lang={lang} />}
                </div>
                {mode==="signup" && (
                <div>
                  <label htmlFor="auth-cf" style={lbl}>{t("lCf")}</label>
                  <div style={{ position:"relative" }}>
                    <input id="auth-cf" className="auth-input" autoComplete="new-password" type={showCf?"text":"password"} value={cf} onChange={e => setCf(e.target.value)}
                      required minLength={6} placeholder={t("phPw")}
                      style={{
                        ...inp, letterSpacing: showCf?"normal":"0.06em",
                        ...(cf && cf!==pw ? {borderColor:"#fca5a5"} : {}),
                        ...(cf && cf===pw  ? {borderColor:"#86efac"} : {}),
                      }}
                      onFocus={onFocus} onBlur={onBlur} />
                    <button type="button" style={eyeBtn} onClick={() => setShowCf(v=>!v)} aria-label={showCf ? "Hide password" : "Show password"}>
                      <EyeIcon open={showCf} />
                    </button>
                  </div>
                  {cf && cf!==pw && <p style={{fontSize:11,color:"#ef4444",marginTop:4}}>✗ {lang==="ar"?"غير متطابقتين":"Doesn't match"}</p>}
                  {cf && cf===pw  && <p style={{fontSize:11,color:"#22c55e",marginTop:4}}>✓ {lang==="ar"?"متطابقتان":"Matches"}</p>}
                </div>
                )}
                </div>
              )}

              {mode==="signin" && (
                <div role="checkbox" aria-checked={remember} tabIndex={0}
                  onClick={() => setRemember(r=>!r)}
                  onKeyDown={e => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); setRemember(r=>!r); } }}
                  style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer",minHeight:44,margin:"-6px 0",alignSelf:"flex-start",paddingInlineEnd:12}}>
                  <div style={chk(remember)}>
                    {remember && <span style={{color:"#fff",fontSize:9,fontWeight:900}}>✓</span>}
                  </div>
                  <span style={{fontSize:13,color:"#64748b",userSelect:"none"}}>{t("remember")}</span>
                </div>
              )}

              {mode==="signup" && (
                <div role="checkbox" aria-checked={agreed} tabIndex={0}
                  onClick={() => setAgreed(a=>!a)}
                  onKeyDown={e => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); setAgreed(a=>!a); } }}
                  style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer",minHeight:44,margin:"-6px 0"}}>
                  <div style={chk(agreed)}>
                    {agreed && <span style={{color:"#fff",fontSize:9,fontWeight:900}}>✓</span>}
                  </div>
                  <span style={{fontSize:13,color:"#64748b",lineHeight:1.6,userSelect:"none"}}>
                    {t("terms1")}{" "}
                    <a href="/policy#terms" target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{color:"#7c3aed",textDecoration:"none",fontWeight:600,padding:"14px 4px"}}>{t("termsA")}</a>
                    {" "}{t("terms2")}{" "}
                    <a href="/policy#privacy" target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{color:"#7c3aed",textDecoration:"none",fontWeight:600,padding:"14px 4px"}}>{t("termsB")}</a>
                  </span>
                </div>
              )}

              {accountStatus && (
                <div style={{background:"#fef2f2",border:"1.5px solid #fecaca",borderRadius:10,padding:"10px 14px",fontSize:12,color:"#dc2626",display:"flex",gap:8,alignItems:"flex-start"}}>
                  <span>⚠</span>
                  <span>
                    {lang === "ar"
                      ? "تم حظر هذا الحساب. يرجى التواصل مع الدعم."
                      : "This account has been banned. Please contact support."}
                  </span>
                </div>
              )}

              {error && (
                <div style={{background:"#fef2f2",border:"1.5px solid #fecaca",borderRadius:10,padding:"10px 14px",fontSize:12,color:"#dc2626",display:"flex",gap:8,alignItems:"center"}}>
                  <span>⚠</span>{error}
                </div>
              )}
              {info && (
                <div style={{background:"#f0fdf4",border:"1.5px solid #bbf7d0",borderRadius:10,padding:"10px 14px",fontSize:12,color:"#16a34a",display:"flex",gap:8,alignItems:"center"}}>
                  <span>✓</span>{info}
                </div>
              )}

              <button type="submit" disabled={loading} style={{
                width:"100%", padding:"12px", borderRadius:12, border:"none",
                cursor: loading ? "default" : "pointer",
                fontSize:14, fontWeight:700, color:"#fff", fontFamily:"inherit",
                background: loading ? "#5B6685" : "#132043",
                boxShadow:"0 4px 14px rgba(19,32,67,0.24)",
                marginTop:0, transition:"all .15s",
              }}>
                {loading ? t("btnLoad") :
                  mode==="signin" ? `${t("btnIn")} ${isRtl ? "←" : "→"}` :
                  mode==="signup" ? `${t("btnUp")} ${isRtl ? "←" : "→"}` :
                  t("btnReset")}
              </button>
            </form>
          )}

          {/* Social */}
          {mode !== "forgot" && !resetSent && !signupSent && (
            <>
              <div style={{display:"flex",alignItems:"center",gap:12,margin:"12px 0 10px"}}>
                <div style={{flex:1,height:1,background:"#f1f5f9"}} />
                <span style={{fontSize:12,color:"#9ca3af",fontWeight:500}}>{t("orWith")}</span>
                <div style={{flex:1,height:1,background:"#f1f5f9"}} />
              </div>
              {/* Google's own button: knows the accounts on this device, so it
                  is one tap with nothing typed. Renders nothing where it cannot
                  run (in-app browsers, blockers), and ours below still works. */}
              <GoogleOneTap lang={lang} onError={(m) => setError(m)} onRendered={() => setGoogleReady(true)} />
              {/* Ours is the way in when Google's button cannot run -- an in-app
                  browser, a blocker, a network that drops their script. When it
                  did render, this would just be the same button twice. */}
              {!googleReady && (
              <button type="button" onClick={() => oauth("google")} style={{
                width:"100%", padding:"12px", borderRadius:11,
                border:"1.5px solid #e5e7eb", background:"#fff",
                cursor:"pointer", fontSize:13.5, fontWeight:500, color:"#374151",
                display:"flex", alignItems:"center", justifyContent:"center", gap:8,
                fontFamily:"inherit",
              }}>
                <svg width="15" height="15" viewBox="0 0 48 48">
                  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                </svg>
                {lang === "ar" ? "تسجيل الدخول عبر Google" : "Continue with Google"}
              </button>
              )}
              {googleReady && (
                <p style={{textAlign:"center",margin:"2px 0 0"}}>
                  <button type="button" onClick={() => oauth("google")} style={{
                    background:"none",border:"none",cursor:"pointer",color:"#9ca3af",
                    fontSize:12.5,fontFamily:"inherit",padding:"12px 8px",textDecoration:"underline",
                  }}>
                    {lang === "ar" ? "لم تظهر حساباتك؟ جرّب الطريقة الأخرى" : "Accounts not showing? Try the other way"}
                  </button>
                </p>
              )}
            </>
          )}

          {/* Switch */}
          {mode !== "forgot" && !signupSent && (
            <p style={{textAlign:"center",fontSize:13,color:"#9ca3af",marginTop:12,marginBottom:0}}>
              {mode==="signin" ? `${t("noAcct")} ` : `${t("haveAcct")} `}
              <button onClick={() => go(mode==="signin" ? "signup" : "signin")}
                style={{background:"none",border:"none",cursor:"pointer",color:"#7c3aed",fontWeight:700,fontSize:13,fontFamily:"inherit",padding:"13px 8px",margin:"-13px -8px"}}>
                {mode==="signin" ? t("goUp") : t("goIn")}
              </button>
            </p>
          )}
          {mode==="forgot" && !resetSent && (
            <button onClick={() => go("signin")}
              style={{display:"block",margin:"18px auto 0",background:"none",border:"none",cursor:"pointer",color:"#9ca3af",fontSize:12,fontFamily:"inherit"}}>
              {t("backIn")}
            </button>
          )}

          </div>{/* end directional slide wrapper */}
        </div>
      </div>

      <style>{`
        .auth-rings { position:absolute; inset:0; pointer-events:none; z-index:0; }
        .auth-ring {
          position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
          border-radius:50%; border:1px solid rgba(19,32,67,0.12);
        }
        .auth-ring-1 { width:560px;  height:560px;  border-color:rgba(19,32,67,0.16); }
        .auth-ring-2 { width:820px;  height:820px;  border-color:rgba(19,32,67,0.12); }
        .auth-ring-3 { width:1080px; height:1080px; border-color:rgba(19,32,67,0.09); }
        .auth-ring-4 { width:1340px; height:1340px; border-color:rgba(19,32,67,0.06); }
        .auth-card button, .auth-card a, .auth-card [role=checkbox] { touch-action: manipulation; }
        .auth-pw-pair { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
        .auth-pw-pair div { min-width:0; }
        /* wide letter-spacing on password fields is for the dots, not for the hint text */
        .auth-input::placeholder { letter-spacing:normal; }
        @media (max-width: 640px) {
          /* 16px stops iOS Safari zooming the page when a field is tapped */
          .auth-input { font-size: 16px !important; padding-top: 9px !important; padding-bottom: 9px !important; }
          .auth-page { padding-top: max(10px, env(safe-area-inset-top)) !important; padding-bottom: max(10px, env(safe-area-inset-bottom)) !important; }
          .auth-card { padding: 14px 16px 16px !important; border-radius: 18px !important; }
          .auth-pw-pair { grid-template-columns:1fr; }
          /* white space either side of the card on phones */
          .auth-page { padding-left: 38px !important; padding-right: 38px !important; }
          .auth-card h1 { font-size: 20px !important; }
          .auth-ring-1 { width:380px; height:380px; }
          .auth-ring-2 { width:560px; height:560px; }
          .auth-ring-3 { width:740px; height:740px; }
          .auth-ring-4 { width:920px; height:920px; }
        }
      `}</style>
    </div>
  );
}
