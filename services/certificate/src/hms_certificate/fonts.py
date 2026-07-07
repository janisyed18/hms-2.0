"""Font registration for archival PDFs.

Embedding TrueType fonts is a prerequisite for PDF/A. We register DejaVu Sans if
it can be found in common locations (or via config); otherwise we fall back to
the built-in Helvetica (which is not embedded, so the output is a normal PDF
rather than strictly PDF/A). The chosen family names are returned so callers can
build paragraph styles without caring which path was taken.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

_CANDIDATE_DIRS = (
    "/usr/share/fonts/truetype/dejavu",
    "/usr/share/fonts/dejavu",
    "/Library/Fonts",
    "/System/Library/Fonts/Supplemental",
    "C:/Windows/Fonts",
)

_REGULAR_CANDIDATES = ("DejaVuSans.ttf",)
_BOLD_CANDIDATES = ("DejaVuSans-Bold.ttf",)

_REGISTERED = False


@dataclass(frozen=True)
class FontFamily:
    regular: str
    bold: str
    embedded: bool


def _find(names: tuple[str, ...], override: str | None) -> Path | None:
    if override:
        p = Path(override)
        return p if p.exists() else None
    for directory in _CANDIDATE_DIRS:
        for name in names:
            candidate = Path(directory) / name
            if candidate.exists():
                return candidate
    return None


def register_fonts(
    regular_path: str | None = None,
    bold_path: str | None = None,
) -> FontFamily:
    """Register embeddable fonts, returning the family names to use."""
    global _REGISTERED
    regular = _find(_REGULAR_CANDIDATES, regular_path)
    bold = _find(_BOLD_CANDIDATES, bold_path)
    if regular is None or bold is None:
        return FontFamily(regular="Helvetica", bold="Helvetica-Bold", embedded=False)

    if not _REGISTERED:
        pdfmetrics.registerFont(TTFont("HMSSans", str(regular)))
        pdfmetrics.registerFont(TTFont("HMSSans-Bold", str(bold)))
        pdfmetrics.registerFontFamily(
            "HMSSans", normal="HMSSans", bold="HMSSans-Bold"
        )
        _REGISTERED = True
    return FontFamily(regular="HMSSans", bold="HMSSans-Bold", embedded=True)
