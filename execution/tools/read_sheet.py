"""
Tool: read_sheet
Reads rows from a Google Sheet and returns them as structured data.

Args:
    spreadsheet_id (str): The Google Sheets document ID (from the URL)
    range_name (str): A1 notation range, e.g. "Sheet1!A1:Z100" or just "Sheet1"

Returns:
    dict: {
        "success": bool,
        "rows": list[list[str]],   raw rows (first row is headers)
        "headers": list[str],
        "records": list[dict],     rows zipped with headers as keys
        "error": str | None
    }

Env vars required:
    GOOGLE_CREDENTIALS_PATH  Path to credentials.json (default: credentials.json)
    GOOGLE_TOKEN_PATH        Path to token.json (default: token.json)
"""

from ._google_auth import get_google_credentials

SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]


def read_sheet(spreadsheet_id: str, range_name: str) -> dict:
    try:
        creds = get_google_credentials(SCOPES)
        from googleapiclient.discovery import build

        service = build("sheets", "v4", credentials=creds)
        result = (
            service.spreadsheets()
            .values()
            .get(spreadsheetId=spreadsheet_id, range=range_name)
            .execute()
        )
        rows = result.get("values", [])
        if not rows:
            return {"success": True, "rows": [], "headers": [], "records": [], "error": None}

        headers = rows[0]
        records = [dict(zip(headers, row)) for row in rows[1:]]
        return {
            "success": True,
            "rows": rows,
            "headers": headers,
            "records": records,
            "error": None,
        }
    except Exception as e:
        return {"success": False, "rows": [], "headers": [], "records": [], "error": str(e)}
