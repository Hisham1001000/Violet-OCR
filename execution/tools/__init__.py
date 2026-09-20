from .send_email import send_email
from .read_sheet import read_sheet
from .update_sheet import update_sheet

TOOL_REGISTRY = {
    "send_email": send_email,
    "read_sheet": read_sheet,
    "update_sheet": update_sheet,
}
