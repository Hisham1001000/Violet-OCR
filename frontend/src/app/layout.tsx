import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";
import { LangProvider } from "@/lib/lang-context";

export const dynamic = "force-dynamic";

// Microsoft Clarity project for violetocr.com: heatmaps, session recordings,
// rage clicks. Loaded only in production, so local testing never pollutes the
// recordings. The id is public by design -- it only names the project.
const CLARITY_ID = "ygte28gktf";
// Meta pixel: counts ad visits and signups so campaigns can optimise for
// customers instead of clicks. The landing page carries its own copy.
// Two datasets exist in the Meta account, both named "violet", and the ad account
// defaults to the second. Reporting to both means no ad can track an empty one.
const META_PIXEL_IDS = ["1829788774696879", "1083983997650429"];

// Every Material Symbols icon the app renders, comma-separated and sorted.
// Used to subset the icon font (see the <link> below). Add to it when you
// add an icon, or that icon will silently render as nothing.
const MATERIAL_ICONS =
  "account_balance_wallet,arrow_back,arrow_forward,attach_money,auto_awesome,auto_stories,bar_chart,block,bolt,bug_report,chat,check,check_circle,checklist,chevron_right,close,cloud,cloud_upload,compare,credit_card,dashboard,delete,description,document_scanner,download,emoji_events,error,expand_less,expand_more,failed,file_download,group,help,history,hourglass_empty,image,inbox,insights,keyboard_double_arrow_down,language,lightbulb,lock,login,logout,mail,manage_accounts,menu,menu_book,model_training,notifications,notifications_none,people,person,photo_camera,photo_library,playlist_add,playlist_add_check,refresh,restart_alt,school,search,settings,table_chart,table_rows,table_view,task_alt,toggle_on,toll,trending_up,upgrade,upload,upload_file,verified,visibility,warning,workspace_premium";

export const metadata: Metadata = {
  other: { "facebook-domain-verification": "u2f1vv7hawyi1gmnk4c78k6tk1h67s" },
  title: "Violet",
  description: "AI-powered Arabic OCR processing platform",
  icons: {
    icon: "/logo.png",
    apple: "/logo.png",
  },
  openGraph: {
    title: "Violet",
    description: "AI-powered Arabic OCR processing platform",
    images: [{ url: "/logo.png" }],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        {/* ── Warm the connections before anything needs them ──────────────
            Every one of these is a separate origin needing DNS + TCP + TLS
            before its first byte. On a high-latency link that handshake is
            300-600ms, and without these hints it is paid serially at the
            moment the browser discovers the resource. Supabase matters most:
            it is the first thing every authenticated page talks to. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {process.env.NEXT_PUBLIC_SUPABASE_URL && (
          <link rel="preconnect" href={process.env.NEXT_PUBLIC_SUPABASE_URL} crossOrigin="anonymous" />
        )}

        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Cairo:wght@300;400;500;600;700&display=swap"
          rel="stylesheet"
        />
        {/* ── Icon font, subset to what we actually draw ────────────────
            The unsubsetted Material Symbols variable font is 1,131,920 bytes.
            Every icon in this app is one of the 75 names below, so `icon_names`
            cuts it to 23,076 — a 1.1 MB saving on first load, and the reason
            icons used to take a visible moment to appear.

            IF YOU ADD A NEW ICON, ADD ITS NAME HERE. A name that is not in this
            list renders as nothing at all, with no error.

            display=block, not swap: Material Symbols draws from ligatures, so
            the element's text content is literally the icon name. Under `swap`
            the browser paints that fallback text while the font loads, which is
            how "check_circle" once appeared in the UI as the word
            "check_circle". `block` shows nothing briefly, then the glyph. The
            text fonts above keep `swap` — invisible prose is worse than
            restyled prose. */}
        <link
          href={`https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&icon_names=${MATERIAL_ICONS}&display=block`}
          rel="stylesheet"
        />
      </head>
      <body
        className="bg-surface text-on-surface antialiased min-h-screen"
        style={{ fontFamily: "Inter, sans-serif" }}
      >
        <LangProvider>
          {children}
        </LangProvider>
        {process.env.NODE_ENV === "production" && (
          // afterInteractive: the page becomes usable first, then the tags load.
          <>
          <Script id="meta-pixel" strategy="afterInteractive">
            {`!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');${META_PIXEL_IDS.map(id => `fbq('init','${id}');`).join('')}fbq('track','PageView');`}
          </Script>
          <Script id="ms-clarity" strategy="afterInteractive">
            {`(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script","${CLARITY_ID}");`}
          </Script>
          </>
        )}
      </body>
    </html>
  );
}
