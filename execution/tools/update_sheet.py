"""
Tool: update_sheet
Writes or appends data to a Google Sheet.

Args:
    spreadsheet_id (str): The Google Sheets document ID (from the URL)
    range_name (str): A1 notation range, e.g. "Sheet1!A2:C10"
    values (list[list]): 2D array of values to write
    mode (str): "write" (overwrites range) or "append" (adds after last row). Default "write".

Returns:
    dict: {
        "success": bool,
        "updated_cells": int,
        "error": str | None
    }

Env vars required:
    GOOGLE_CREDENTIALS_PATH  Path to credentials.json (default: credentials.json)
    GOOGLE_TOKEN_PATH        Path to token.json (default: token.json)
"""

from ._google_auth import get_google_credentials

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]


def update_sheet(
    spreadsheet_id: str,
    range_name: str,
    values: list,
    mode: str = "write",
) -> dict:
    try:
        creds = get_google_credentials(SCOPES)
        from googleapiclient.discovery import build

        service = build("sheets", "v4", credentials=creds)
        body = {"values": values}

        if mode == "append":
            result = (
                service.spreadsheets()
                .values()
                .append(
                    spreadsheetId=spreadsheet_id,
                    range=range_name,
                    valueInputOption="USER_ENTERED",
                    insertDataOption="INSERT_ROWS",
                    body=body,
                )
                .execute()
            )
            updated = result.get("updates", {}).get("updatedCells", 0)
        else:
            result = (
                service.spreadsheets()
                .values()
                .update(
                    spreadsheetId=spreadsheet_id,
                    range=range_name,
                    valueInputOption="USER_ENTERED",
                    body=body,
                )
                .execute()
            )
            updated = result.get("updatedCells", 0)

        return {"success": True, "updated_cells": updated, "error": None}
    except Exception as e:
        return {"success": False, "updated_cells": 0, "error": str(e)}
