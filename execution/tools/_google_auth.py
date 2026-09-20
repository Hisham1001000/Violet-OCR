"""
Shared Google OAuth credential helper.
Used by read_sheet.py and update_sheet.py.
"""

import os
from pathlib import Path


def get_google_credentials(scopes: list):
    """
    Returns valid Google OAuth2 credentials.
    On first run, opens a browser for OAuth consent.
    On subsequent runs, refreshes from token.json automatically.

    Args:
        scopes: List of Google API scopes to request.

    Env vars:
        GOOGLE_CREDENTIALS_PATH  Path to credentials.json (default: credentials.json)
        GOOGLE_TOKEN_PATH        Path to token.json (default: token.json)
    """
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow
    from google.auth.transport.requests import Request

    creds_path = os.getenv("GOOGLE_CREDENTIALS_PATH", "credentials.json")
    token_path = os.getenv("GOOGLE_TOKEN_PATH", "token.json")
    creds = None

    if Path(token_path).exists():
        creds = Credentials.from_authorized_user_file(token_path, scopes)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(creds_path, scopes)
            creds = flow.run_local_server(port=0)
        with open(token_path, "w") as f:
            f.write(creds.to_json())

    return creds
