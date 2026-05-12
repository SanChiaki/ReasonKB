from pathlib import Path
from pkgutil import extend_path


_VENDOR_PACKAGE = Path(__file__).resolve().parents[1] / "vendor" / "pageindex" / "pageindex"
__path__ = extend_path(__path__, __name__)
if _VENDOR_PACKAGE.is_dir():
    vendor_path = str(_VENDOR_PACKAGE)
    if vendor_path not in __path__:
        __path__.append(vendor_path)

from .page_index import *  # noqa: F401,F403,E402
from .page_index_md import md_to_tree  # noqa: F401,E402
from .retrieve import get_document, get_document_structure, get_page_content  # noqa: F401,E402
from .client import PageIndexClient  # noqa: F401,E402

try:
    from services.common.pageindex_runtime import configure_pageindex_runtime

    configure_pageindex_runtime()
except Exception:
    pass
