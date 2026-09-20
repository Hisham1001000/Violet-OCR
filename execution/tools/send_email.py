"""
Tool: send_email
Sends an email via SendGrid (preferred) or falls back to SMTP.

Args:
    to (str | list[str]): Recipient email address(es)
    subject (str): Email subject line
    body (str): Email body — plain text or HTML
    html (bool): If True, body is treated as HTML. Default False.

Returns:
    dict: {"success": bool, "message_id": str | None, "error": str | None}

Env vars (one provider required):
    SENDGRID_API_KEY              SendGrid API key (preferred)
    SMTP_HOST, SMTP_PORT,
    SMTP_USER, SMTP_PASSWORD      SMTP fallback (used if SendGrid key absent)
    SMTP_USER                     Also used as the From address for SendGrid
"""

import os
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Union


def send_email(
    to: Union[str, list],
    subject: str,
    body: str,
    html: bool = False,
) -> dict:
    api_key = os.getenv("SENDGRID_API_KEY")
    if api_key:
        return _send_via_sendgrid(to, subject, body, html, api_key)
    return _send_via_smtp(to, subject, body, html)


def _send_via_sendgrid(to, subject, body, html, api_key):
    try:
        import sendgrid
        from sendgrid.helpers.mail import Mail

        to_list = [to] if isinstance(to, str) else to
        from_email = os.getenv("SMTP_USER", "noreply@example.com")
        message = Mail(
            from_email=from_email,
            to_emails=to_list,
            subject=subject,
            html_content=body if html else f"<pre>{body}</pre>",
        )
        sg = sendgrid.SendGridAPIClient(api_key=api_key)
        response = sg.send(message)
        return {
            "success": response.status_code in (200, 202),
            "message_id": response.headers.get("X-Message-Id"),
            "error": None,
        }
    except Exception as e:
        return {"success": False, "message_id": None, "error": str(e)}


def _send_via_smtp(to, subject, body, html):
    try:
        host = os.getenv("SMTP_HOST", "smtp.gmail.com")
        port = int(os.getenv("SMTP_PORT", 587))
        user = os.getenv("SMTP_USER")
        password = os.getenv("SMTP_PASSWORD")

        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = user
        msg["To"] = to if isinstance(to, str) else ", ".join(to)
        msg.attach(MIMEText(body, "html" if html else "plain"))

        with smtplib.SMTP(host, port) as server:
            server.ehlo()
            server.starttls()
            server.login(user, password)
            recipients = to if isinstance(to, list) else [to]
            server.sendmail(user, recipients, msg.as_string())

        return {"success": True, "message_id": None, "error": None}
    except Exception as e:
        return {"success": False, "message_id": None, "error": str(e)}
