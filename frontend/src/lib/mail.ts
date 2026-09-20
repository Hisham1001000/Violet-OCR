// Importing this from a client component is a build error, not a code review
// comment: holds the Resend API key and SMTP credentials.
import "server-only";

/**
 * One way to send mail, for both places that send it.
 *
 * SMTP does not work on Vercel. A serverless function there could not even
 * resolve the mail host — every send failed with `getaddrinfo EBUSY
 * smtp.resend.com`, and before that Gmail's host behaved the same way — so
 * feedback and support messages were being written to the database and never
 * delivered. Outbound SMTP is simply not available in that runtime.
 *
 * So: when RESEND_API_KEY is set we post the message to Resend over plain
 * HTTPS, which the runtime does allow. Without that key we fall back to SMTP
 * through nodemailer, which is what a local machine (and any normal server)
 * can do, so `npm run dev` keeps working with a Gmail app password.
 *
 * The sender: MAIL_FROM, e.g. `Violet <feedback@violetocr.com>`. Resend only
 * accepts an address on a domain it has verified — until violetocr.com is
 * green, `Violet <onboarding@resend.dev>` is Resend's own sender and can
 * deliver to the account's own address.
 */
import nodemailer from "nodemailer";

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
  /** Name shown when MAIL_FROM is not set and we fall back to the SMTP login. */
  fallbackName?: string;
}

function sender(fallbackName: string): string {
  return process.env.MAIL_FROM || `"${fallbackName}" <${process.env.SMTP_USER}>`;
}

// One pooled transporter per instance: connect + auth to Gmail costs ~2.4s, and
// paying that on every message is the difference between a snappy form and one
// that feels broken.
let _transporter: nodemailer.Transporter | null = null;
function mailer(): nodemailer.Transporter {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST ?? "smtp.gmail.com",
      port:   parseInt(process.env.SMTP_PORT ?? "587"),
      secure: false,
      auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
      pool:   true,
      maxConnections: 2,
      connectionTimeout: 10_000,
      greetingTimeout:   10_000,
      socketTimeout:     20_000,
    });
  }
  return _transporter;
}

/**
 * Sends the message. Throws on failure, with a message worth logging — the
 * caller decides whether a failed notification is worth failing the request
 * over (it never is: the feedback or ticket is already stored).
 */
export async function sendMail(msg: MailMessage): Promise<void> {
  const from = sender(msg.fallbackName ?? "Violet");
  const key  = process.env.RESEND_API_KEY;

  if (key) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15_000);
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [msg.to],
          subject: msg.subject,
          html: msg.html,
          ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
        }),
        signal: ctl.signal,
      });
      if (!res.ok) {
        // Resend explains refusals properly ("domain is not verified", "invalid
        // from"), and that sentence is the whole diagnosis when mail stops.
        const body = await res.text();
        throw new Error(`Resend ${res.status}: ${body.slice(0, 300)}`);
      }
      return;
    } finally {
      clearTimeout(timer);
    }
  }

  await mailer().sendMail({
    from,
    to:      msg.to,
    replyTo: msg.replyTo,
    subject: msg.subject,
    html:    msg.html,
  });
}
