SUPPORTED_MEDIA_BY_EXTENSION = {
    ".pdf": "pdf",
    ".doc": "office",
    ".docx": "office",
    ".xls": "office",
    ".xlsx": "office",
    ".xlsm": "office",
    ".ppt": "office",
    ".pptx": "office",
    ".md": "markdown",
    ".markdown": "markdown",
    ".txt": "text",
    ".text": "text",
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".webp": "image",
    ".tif": "image",
    ".tiff": "image",
}

IGNORED_NAMES = {".DS_Store", "Thumbs.db"}


def media_type_for_name(name: str) -> str:
    dot = name.rfind(".")
    extension = name[dot:].lower() if dot >= 0 else ""
    return SUPPORTED_MEDIA_BY_EXTENSION.get(extension, "unsupported")


def is_ignored_name(name: str) -> bool:
    return name.startswith(".") or name in IGNORED_NAMES
