"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { useLang } from "@/lib/lang-context";

const tx = (en: string, ar: string) => ({ en, ar });
const C = {
  title:    tx("Create new password",      "إنشاء كلمة مرور جديدة"),
  sub:      tx("Choose a strong password for your account.", "اختر كلمة مرور قوية لحسابك."),
  lPw:      tx("New Password",             "كلمة المرور الجديدة"),
  lCf:      tx("Confirm Password",         "تأكيد كلمة المرور"),
  phPw:     tx("Min. 6 characters",        "٦ أحرف على الأقل"),
  btn:      tx("Save new password",        "حفظ كلمة المرور"),
  loading:  tx("Saving…",                  "جارٍ الحفظ…"),
  success:  tx("Password updated! Redirecting to sign in…", "تم تحديث كلمة المرور! جارٍ التحويل…"),
  errMatch: tx("Passwords don't match.",   "كلمتا المرور غير متطابقتين."),
  errWeak:  tx("Password is too weak (min. 6 characters).", "كلمة المرور ضعيفة (٦ أحرف على الأقل)."),
  errLink:  tx("This reset link is invalid or has expired. Please request a new one.", "رابط الاستعادة غير صالح أو انتهت صلاحيته. يرجى طلب رابط جديد."),
  back:     tx("Back to sign in",          "العودة لتسجيل الدخول"),
  s1: tx("Weak","ضعيفة"), s2: tx("Fair","مقبولة"),
  s3: tx("Good","جيدة"),  s4: tx("Strong","قوية"),
};
type L = "en"|"ar";

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

export default function ResetPasswordPage() {
  const { lang } = useLang();
  const isRtl = lang === "ar";
  const t = (k: keyof typeof C) => C[k][lang];

  const [pw, setPw]           = useState("");
  const [cf, setCf]           = useState("");
  const [showPw, setShowPw]   = useState(false);
  const [showCf, setShowCf]   = useState(false);
  const [loading, setLoading] = useState(false);
  const [done, setDone]       = useState(false);
  const [error, setError]     = useState<string|null>(null);
  const [ready, setReady]     = useState(false); // session established from hash

  const sb = createClient();

  // Supabase embeds the recovery token in the URL hash.
  // Listen for the PASSWORD_RECOVERY event which fires automatically.
  useEffect(() => {
    const { data: { subscription } } = sb.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") setReady(true);
    });
    // Also check if already in a recovery session
    sb.auth.getSession().then(({ data }) => {
      if (data.session) setReady(true);
    });
    return () => subscription.unsubscribe();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (pw.length < 6)  { setError(t("errWeak")); return; }
    if (pw !== cf)      { setError(t("errMatch")); return; }
    setLoading(true);
    const { error } = await sb.auth.updateUser({ password: pw });
    setLoading(false);
    if (error) { setError(error.message); return; }
    setDone(true);
    setTimeout(() => { window.location.href = "/auth"; }, 2500);
  }

  const s = pwStr(pw);
  const inp: React.CSSProperties = {
    width:"100%", boxSizing:"border-box",
    background:"#f8fafc", border:"1.5px solid #e2e8f0",
    borderRadius:10, padding:"11px 38px 11px 14px",
    fontSize:13, color:"#0f172a",
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
    ...(isRtl ? { left:12 } : { right:12 }),
    background:"none", border:"none", cursor:"pointer",
    color:"#94a3b8", fontSize:14, padding:0, lineHeight:1,
  };

  return (
    <div
      dir={isRtl ? "rtl" : "ltr"}
      style={{
        minHeight:"100vh", display:"flex", fontFamily:"'Inter','Alexandria',sans-serif",
      }}
    >
      {/* Left dark panel */}
      <div
        className="auth-left"
        style={{
          flex:"0 0 42%", minHeight:"100vh",
          background:"linear-gradient(160deg,#0f0720 0%,#1a0a3a 60%,#0f0720 100%)",
          display:"flex", flexDirection:"column",
          justifyContent:"center", alignItems:"flex-start",
          padding:"48px 44px", position:"relative", overflow:"hidden",
        }}
      >
        <div aria-hidden style={{ position:"absolute", inset:0, pointerEvents:"none" }}>
          <div style={{ position:"absolute", top:"20%", left:"30%", width:420, height:420, borderRadius:"50%", background:"radial-gradient(circle,rgba(124,58,237,0.22) 0%,transparent 65%)" }} />
        </div>
        <div style={{ position:"relative" }}>
          <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:48 }}>
            <img src="/logo.png" alt="Violet" style={{ width:28, height:28, objectFit:"contain", filter:"drop-shadow(0 0 10px rgba(168,85,247,0.65))" }} />
            <span style={{ fontSize:14, fontWeight:800, letterSpacing:"0.18em", color:"rgba(255,255,255,0.85)", textTransform:"uppercase" }}>Violet</span>
          </div>
          <h2 style={{ fontSize:38, fontWeight:900, lineHeight:1.1, background:"linear-gradient(135deg,#f3e8ff,#e879f9,#a855f7)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent", margin:"0 0 16px" }}>
            {lang==="ar" ? "كلمة مرور جديدة" : "New password"}
          </h2>
          <p style={{ fontSize:14, color:"rgba(255,255,255,0.38)", lineHeight:1.6, maxWidth:260, margin:0 }}>
            {lang==="ar" ? "اختر كلمة مرور قوية لتأمين حسابك." : "Choose a strong password to keep your account secure."}
          </p>
        </div>
      </div>

      {/* Right white panel */}
      <div style={{
        flex:1, minHeight:"100vh", background:"#fff",
        display:"flex", flexDirection:"column",
        alignItems:"center", justifyContent:"center",
        padding:"32px 24px", overflowY:"auto",
      }}>
        <div style={{ width:"100%", maxWidth:390 }}>

          {/* Title */}
          <div style={{ marginBottom:28 }}>
            <h1 style={{ fontSize:26, fontWeight:800, color:"#0f172a", margin:"0 0 6px", letterSpacing:"-0.02em" }}>
              {t("title")}
            </h1>
            <p style={{ fontSize:13, color:"#94a3b8", margin:0 }}>{t("sub")}</p>
          </div>

          {/* Invalid link */}
          {!ready && !done && (
            <div style={{ background:"#fef2f2", border:"1.5px solid #fecaca", borderRadius:12, padding:"14px 16px", fontSize:13, color:"#dc2626", marginBottom:20 }}>
              ⚠ {t("errLink")}
            </div>
          )}

          {/* Success */}
          {done && (
            <div style={{ background:"#f0fdf4", border:"1.5px solid #bbf7d0", borderRadius:12, padding:"14px 16px", fontSize:13, color:"#15803d" }}>
              ✓ {t("success")}
            </div>
          )}

          {/* Form */}
          {ready && !done && (
            <form onSubmit={submit} style={{ display:"flex", flexDirection:"column", gap:16 }}>

              {/* New password */}
              <div>
                <label style={{ display:"block", fontSize:11, fontWeight:600, color:"#64748b", marginBottom:6 }}>{t("lPw")}</label>
                <div style={{ position:"relative" }}>
                  <input type={showPw?"text":"password"} value={pw} onChange={e => setPw(e.target.value)}
                    required minLength={6} placeholder={t("phPw")}
                    style={{...inp, letterSpacing: showPw?"normal":"0.06em"}}
                    onFocus={onFocus} onBlur={onBlur} />
                  <button type="button" style={eyeBtn} onClick={() => setShowPw(v=>!v)} aria-label={showPw ? "Hide password" : "Show password"}>
                    <EyeIcon open={showPw} />
                  </button>
                </div>
                {pw && (
                  <div style={{ marginTop:5, display:"flex", alignItems:"center", gap:6 }}>
                    <div style={{ flex:1, display:"flex", gap:3 }}>
                      {[1,2,3,4].map(i => (
                        <div key={i} style={{ flex:1, height:3, borderRadius:99, background: i<=s ? SC[s] : "#e2e8f0", transition:"background .25s" }} />
                      ))}
                    </div>
                    <span style={{ fontSize:10, color:SC[s], fontWeight:600, whiteSpace:"nowrap" }}>{sLbl(s,lang)}</span>
                  </div>
                )}
              </div>

              {/* Confirm */}
              <div>
                <label style={{ display:"block", fontSize:11, fontWeight:600, color:"#64748b", marginBottom:6 }}>{t("lCf")}</label>
                <div style={{ position:"relative" }}>
                  <input type={showCf?"text":"password"} value={cf} onChange={e => setCf(e.target.value)}
                    required minLength={6} placeholder={t("phPw")}
                    style={{
                      ...inp, letterSpacing: showCf?"normal":"0.06em",
                      ...(cf && cf!==pw ? {borderColor:"#fca5a5"} : {}),
                      ...(cf && cf===pw && pw  ? {borderColor:"#86efac"} : {}),
                    }}
                    onFocus={onFocus} onBlur={onBlur} />
                  <button type="button" style={eyeBtn} onClick={() => setShowCf(v=>!v)} aria-label={showCf ? "Hide password" : "Show password"}>
                    <EyeIcon open={showCf} />
                  </button>
                </div>
                {cf && cf!==pw && <p style={{fontSize:11,color:"#ef4444",marginTop:4}}>✗ {lang==="ar"?"غير متطابقتين":"Doesn't match"}</p>}
                {cf && cf===pw && pw && <p style={{fontSize:11,color:"#22c55e",marginTop:4}}>✓ {lang==="ar"?"متطابقتان":"Matches"}</p>}
              </div>

              {error && (
                <div style={{ background:"#fef2f2", border:"1.5px solid #fecaca", borderRadius:10, padding:"10px 14px", fontSize:12, color:"#dc2626", display:"flex", gap:8 }}>
                  <span>⚠</span>{error}
                </div>
              )}

              <button type="submit" disabled={loading} style={{
                width:"100%", padding:"13px", borderRadius:12, border:"none",
                cursor: loading?"default":"pointer",
                fontSize:14, fontWeight:700, color:"#fff", fontFamily:"inherit",
                background: loading?"#a78bfa":"linear-gradient(135deg,#7c3aed,#6d28d9)",
                boxShadow:"0 4px 16px rgba(109,40,217,0.30)",
                marginTop:2,
              }}>
                {loading ? t("loading") : t("btn")}
              </button>
            </form>
          )}

          <a href="/auth" style={{ display:"block", textAlign:"center", marginTop:22, fontSize:12, color:"#94a3b8", textDecoration:"none" }}>
            ← {t("back")}
          </a>
        </div>
      </div>

      <style>{`
        @media (max-width: 768px) { .auth-left { display: none !important; } }
      `}</style>
    </div>
  );
}
