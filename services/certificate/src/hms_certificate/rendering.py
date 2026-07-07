"""Certificate PDF rendering with ReportLab.

Produces a clean, single- or two-page A4 hose assembly test certificate with an
embedded QR code linking to the public verification endpoint, the SHA-256
verification hash, and archival document metadata. The output is unsigned; the
caller passes it to :mod:`hms_certificate.signing`.
"""

from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO

import qrcode
from qrcode.image.pil import PilImage
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    Image,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

from hms_certificate.config import Settings
from hms_certificate.domain import CertificateData
from hms_certificate.fonts import FontFamily, register_fonts

# Brand palette
_NAVY = colors.HexColor("#0f2544")
_ACCENT = colors.HexColor("#1f6feb")
_LIGHT = colors.HexColor("#eef2f7")
_MUTED = colors.HexColor("#5b6b80")
_PASS = colors.HexColor("#137333")
_FAIL = colors.HexColor("#b3261e")
_LINE = colors.HexColor("#c9d4e2")

_PAGE_W, _PAGE_H = A4
_MARGIN = 16 * mm


@dataclass(frozen=True)
class RenderResult:
    pdf: bytes
    page_count: int


class _Styles:
    def __init__(self, family: FontFamily) -> None:
        self.family = family
        self.h1 = ParagraphStyle(
            "h1", fontName=family.bold, fontSize=16, leading=19, textColor=_NAVY
        )
        self.issuer = ParagraphStyle(
            "issuer", fontName=family.bold, fontSize=11, leading=13, textColor=_NAVY
        )
        self.issuer_sub = ParagraphStyle(
            "issuer_sub", fontName=family.regular, fontSize=7.5, leading=10,
            textColor=_MUTED,
        )
        self.section = ParagraphStyle(
            "section", fontName=family.bold, fontSize=9, leading=12,
            textColor=colors.white,
        )
        self.label = ParagraphStyle(
            "label", fontName=family.regular, fontSize=7, leading=9, textColor=_MUTED,
        )
        self.value = ParagraphStyle(
            "value", fontName=family.bold, fontSize=8.5, leading=11, textColor=_NAVY,
        )
        self.cell = ParagraphStyle(
            "cell", fontName=family.regular, fontSize=8, leading=10, textColor=_NAVY,
        )
        self.cell_head = ParagraphStyle(
            "cell_head", fontName=family.bold, fontSize=7.5, leading=10,
            textColor=colors.white,
        )
        self.footer = ParagraphStyle(
            "footer", fontName=family.regular, fontSize=6.5, leading=8.5,
            textColor=_MUTED,
        )
        self.mono = ParagraphStyle(
            "mono", fontName="Courier", fontSize=7, leading=9, textColor=_NAVY,
        )
        self.verify = ParagraphStyle(
            "verify", fontName=family.regular, fontSize=7.5, leading=10,
            textColor=_NAVY,
        )


def render_certificate(
    data: CertificateData,
    verification_hash: str,
    settings: Settings,
) -> RenderResult:
    family = register_fonts()
    styles = _Styles(family)
    buffer = BytesIO()

    page_counter = {"count": 0}

    def _on_page(canvas, doc) -> None:  # noqa: ANN001
        page_counter["count"] = doc.page
        _draw_footer(canvas, styles, data, verification_hash)

    frame = Frame(
        _MARGIN,
        _MARGIN + 12 * mm,
        _PAGE_W - 2 * _MARGIN,
        _PAGE_H - 2 * _MARGIN - 12 * mm,
        id="body",
        leftPadding=0,
        rightPadding=0,
        topPadding=0,
        bottomPadding=0,
    )
    doc = BaseDocTemplate(
        buffer,
        pagesize=A4,
        title=f"Certificate {data.certificate_number}",
        author=settings.issuer_name,
        subject="Hose assembly test & inspection certificate",
        creator="HMS 2.0 Certificate Engine",
        keywords=(
            f"certificate,{data.certificate_number},{data.asset_number},"
            f"{verification_hash}"
        ),
    )
    doc.addPageTemplates(
        [PageTemplate(id="cert", frames=[frame], onPage=_on_page)]
    )
    doc.build(_story(data, verification_hash, styles, settings))

    return RenderResult(pdf=buffer.getvalue(), page_count=page_counter["count"] or 1)


# --- Story construction ---------------------------------------------------------


def _story(
    data: CertificateData,
    verification_hash: str,
    s: _Styles,
    settings: Settings,
) -> list:
    story: list = []
    story.append(_header(data, s, settings))
    story.append(Spacer(1, 6))
    story.append(_summary_band(data, s))
    story.append(Spacer(1, 8))
    story.append(_section_title("Customer & Site", s))
    story.append(_facts_grid(_customer_facts(data), s))
    story.append(Spacer(1, 6))
    story.append(_section_title("Hose Assembly", s))
    story.append(_facts_grid(_asset_facts(data), s))
    story.append(Spacer(1, 6))
    story.append(_section_title("End Configuration", s))
    story.append(_ends_table(data, s))
    story.append(Spacer(1, 6))
    story.append(_section_title("Pressure Test", s))
    story.append(_pressure_table(data, s))
    story.append(Spacer(1, 6))
    story.append(_section_title("Inspection & Approval", s))
    story.append(_facts_grid(_inspection_facts(data), s))
    story.append(Spacer(1, 8))
    story.append(_verification_block(data, verification_hash, s))
    return story


def _header(data: CertificateData, s: _Styles, settings: Settings) -> Table:
    issuer_name = data.issuer.name or settings.issuer_name
    issuer_lines = "<br/>".join(
        filter(
            None,
            [
                data.issuer.address or settings.issuer_address,
                data.issuer.contact or settings.issuer_contact,
                data.issuer.identifier or settings.issuer_identifier,
            ],
        )
    )
    left = [
        Paragraph(issuer_name, s.issuer),
        Paragraph(issuer_lines, s.issuer_sub),
    ]
    title_style = ParagraphStyle("t", parent=s.h1, alignment=TA_RIGHT)
    right = [
        Paragraph(settings.field_title, title_style),
        Paragraph(
            f"Certificate No. <b>{_esc(data.certificate_number)}</b>",
            ParagraphStyle("cn", parent=s.verify, alignment=TA_RIGHT),
        ),
    ]
    table = Table([[left, right]], colWidths=[90 * mm, _PAGE_W - 2 * _MARGIN - 90 * mm])
    table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LINEBELOW", (0, 0), (-1, -1), 1.4, _NAVY),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ]
        )
    )
    return table


def _summary_band(data: CertificateData, s: _Styles) -> Table:
    passed = data.pressure_test.passed if data.pressure_test else None
    result_label = data.inspection_result or (
        "PASS" if passed else "FAIL" if passed is False else "—"
    )
    result_color = _PASS if result_label.upper() in {"PASS", "PASSED"} else (
        _FAIL if result_label.upper() in {"FAIL", "FAILED"} else _MUTED
    )
    cells = [
        _summary_cell("ISSUED", _fmt_dt(data.issued_at), s),
        _summary_cell("VALID UNTIL", data.valid_until or "—", s),
        _summary_cell("VERSION", f"v{data.certificate_version}", s),
        _summary_cell("STATUS", data.status or "ISSUED", s),
        _summary_cell("RESULT", result_label.upper(), s, value_color=result_color),
    ]
    widths = [(_PAGE_W - 2 * _MARGIN) / 5] * 5
    table = Table([cells], colWidths=widths)
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), _LIGHT),
                ("BOX", (0, 0), (-1, -1), 0.5, _LINE),
                ("INNERGRID", (0, 0), (-1, -1), 0.5, _LINE),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]
        )
    )
    return table


def _summary_cell(label: str, value: str, s: _Styles, value_color=_NAVY) -> list:
    return [
        Paragraph(label, ParagraphStyle("sl", parent=s.label, alignment=TA_CENTER)),
        Paragraph(
            _esc(value),
            ParagraphStyle(
                "sv", parent=s.value, alignment=TA_CENTER, fontSize=9.5,
                textColor=value_color,
            ),
        ),
    ]


def _section_title(title: str, s: _Styles) -> Table:
    width = _PAGE_W - 2 * _MARGIN
    table = Table([[Paragraph(title.upper(), s.section)]], colWidths=[width])
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), _NAVY),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ]
        )
    )
    return table


def _facts_grid(facts: list[tuple[str, str]], s: _Styles) -> Table:
    # Two label/value pairs per row.
    rows: list[list] = []
    for i in range(0, len(facts), 2):
        pair = facts[i : i + 2]
        row: list = []
        for label, value in pair:
            row.append(
                [
                    Paragraph(label.upper(), s.label),
                    Paragraph(_esc(value) or "—", s.value),
                ]
            )
        if len(pair) == 1:
            row.append("")
        rows.append(row)
    col = (_PAGE_W - 2 * _MARGIN) / 2
    table = Table(rows, colWidths=[col, col])
    table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ("LINEBELOW", (0, 0), (-1, -1), 0.4, _LINE),
                ("BOX", (0, 0), (-1, -1), 0.5, _LINE),
                ("LINEAFTER", (0, 0), (0, -1), 0.4, _LINE),
            ]
        )
    )
    return table


def _ends_table(data: CertificateData, s: _Styles) -> Table:
    columns = ("END", "NOMINAL BORE", "MATERIAL", "COUPLING", "ADD-ON", "ATTACH METHOD")
    header = [Paragraph(h, s.cell_head) for h in columns]
    rows = [header]
    for e in sorted(data.ends, key=lambda x: x.end) or []:
        rows.append(
            [
                Paragraph(_esc(e.end) or "—", s.cell),
                Paragraph(_esc(e.nominal_bore) or "—", s.cell),
                Paragraph(_esc(e.material) or "—", s.cell),
                Paragraph(_esc(e.coupling) or "—", s.cell),
                Paragraph(_esc(e.coupling_add_on) or "—", s.cell),
                Paragraph(_esc(e.attach_method) or "—", s.cell),
            ]
        )
    if len(rows) == 1:
        empty = Paragraph("No end configuration recorded", s.cell)
        rows.append([empty, "", "", "", "", ""])
    total = _PAGE_W - 2 * _MARGIN
    widths = [total * w for w in (0.08, 0.20, 0.20, 0.20, 0.14, 0.18)]
    return _grid(rows, widths)


def _pressure_table(data: CertificateData, s: _Styles) -> Table:
    pt = data.pressure_test
    header = [
        Paragraph(h, s.cell_head)
        for h in (
            "WORKING (kPa)",
            "TEST RATED (kPa)",
            "APPLIED (kPa)",
            "HOLD TIME",
            "MEDIUM",
            "RESULT",
        )
    ]
    if pt is None:
        body = [Paragraph("No pressure test recorded", s.cell), "", "", "", "", ""]
        rows = [header, body]
    else:
        result = "PASS" if pt.passed else "FAIL"
        result_style = ParagraphStyle(
            "pres", parent=s.cell, fontName=s.family.bold,
            textColor=_PASS if pt.passed else _FAIL,
        )
        rows = [
            header,
            [
                Paragraph(_num(pt.working_pressure_kpa), s.cell),
                Paragraph(_num(pt.test_pressure_kpa), s.cell),
                Paragraph(_num(pt.applied_pressure_kpa), s.cell),
                Paragraph(_hold(pt.hold_time_seconds), s.cell),
                Paragraph(_esc(pt.medium) or "—", s.cell),
                Paragraph(result, result_style),
            ],
        ]
    total = _PAGE_W - 2 * _MARGIN
    widths = [total / 6] * 6
    return _grid(rows, widths)


def _grid(rows: list[list], widths: list[float]) -> Table:
    table = Table(rows, colWidths=widths, repeatRows=1)
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), _ACCENT),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, _LIGHT]),
                ("BOX", (0, 0), (-1, -1), 0.5, _LINE),
                ("INNERGRID", (0, 0), (-1, -1), 0.4, _LINE),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    return table


def _verification_block(
    data: CertificateData,
    verification_hash: str,
    s: _Styles,
) -> Table:
    qr_img = _qr_image(data.verify_url or verification_hash)
    text = [
        Paragraph("<b>Authenticity &amp; Verification</b>", s.value),
        Spacer(1, 3),
        Paragraph(
            "Scan the QR code or visit the URL below to independently verify this "
            "certificate against BAT Engineering's records.",
            s.verify,
        ),
        Spacer(1, 3),
        Paragraph(_esc(data.verify_url) or "—", s.mono),
        Spacer(1, 4),
        Paragraph("SHA-256 VERIFICATION HASH", s.label),
        Paragraph(_wrap_hash(verification_hash), s.mono),
        Spacer(1, 3),
        Paragraph(
            "This document is cryptographically signed (PAdES/X.509). Any "
            "modification after signing invalidates the signature.",
            s.footer,
        ),
    ]
    table = Table(
        [[qr_img, text]],
        colWidths=[34 * mm, _PAGE_W - 2 * _MARGIN - 34 * mm],
    )
    table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("BACKGROUND", (0, 0), (-1, -1), _LIGHT),
                ("BOX", (0, 0), (-1, -1), 0.5, _LINE),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 8),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
            ]
        )
    )
    return table


def _draw_footer(canvas, s, data, verification_hash) -> None:  # noqa: ANN001
    canvas.saveState()
    canvas.setStrokeColor(_LINE)
    canvas.setLineWidth(0.5)
    canvas.line(_MARGIN, _MARGIN + 10 * mm, _PAGE_W - _MARGIN, _MARGIN + 10 * mm)
    canvas.setFont(s.family.regular, 6.5)
    canvas.setFillColor(_MUTED)
    canvas.drawString(
        _MARGIN,
        _MARGIN + 5.5 * mm,
        f"Certificate {data.certificate_number}  •  Asset {data.asset_number}"
        f"  •  Hash {verification_hash[:16]}…",
    )
    canvas.drawRightString(
        _PAGE_W - _MARGIN,
        _MARGIN + 5.5 * mm,
        f"Page {canvas.getPageNumber()}",
    )
    canvas.drawString(
        _MARGIN,
        _MARGIN + 2.5 * mm,
        "Generated by HMS 2.0 Certificate Engine — digitally signed; verify online "
        "before relying on a printed copy.",
    )
    canvas.restoreState()


# --- Facts ----------------------------------------------------------------------


def _customer_facts(d: CertificateData) -> list[tuple[str, str]]:
    return [
        ("Customer", d.customer_name),
        ("Customer Code", d.customer_code),
        ("Site", d.site_name),
        ("Location", d.site_location),
    ]


def _asset_facts(d: CertificateData) -> list[tuple[str, str]]:
    length = f"{d.length_m} m" if d.length_m else ""
    return [
        ("Asset Number", d.asset_number),
        ("Tag", d.asset_tag),
        ("Customer Serial", d.customer_serial_no),
        ("Lifecycle Status", d.lifecycle_status),
        ("Product", f"{d.product_code} — {d.product_name}".strip(" —")),
        ("Category", d.product_category),
        ("Standard", f"{d.standard_code} {d.standard_name}".strip()),
        ("Manufactured", d.manufacture_date),
        ("Length", length),
    ]


def _inspection_facts(d: CertificateData) -> list[tuple[str, str]]:
    return [
        ("Inspection Type", d.inspection_type),
        ("Inspection Ref", d.inspection_id),
        ("Inspector", d.inspector.name),
        ("Reviewer / Approver", d.reviewer.name),
        ("Submitted", _fmt_dt(d.submitted_at)),
        ("Approved", _fmt_dt(d.approved_at)),
        ("Issued By", d.issued_by.name),
        ("Result", d.inspection_result),
    ]


# --- QR + helpers ---------------------------------------------------------------


def _qr_image(payload: str) -> Image:
    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=10,
        border=1,
    )
    qr.add_data(payload or "n/a")
    qr.make(fit=True)
    img: PilImage = qr.make_image(fill_color="#0f2544", back_color="white")
    buf = BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return Image(buf, width=30 * mm, height=30 * mm)


def _esc(value: str) -> str:
    return (
        (value or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def _num(value: int) -> str:
    return f"{value:,}" if value else "—"


def _hold(seconds: int) -> str:
    if not seconds:
        return "—"
    if seconds % 60 == 0:
        return f"{seconds // 60} min"
    return f"{seconds} s"


def _wrap_hash(value: str) -> str:
    # Break the 64-char hex into two lines for a tidy block.
    if len(value) <= 32:
        return value
    return f"{value[:32]}<br/>{value[32:]}"


def _fmt_dt(value: str) -> str:
    if not value:
        return "—"
    # Trim an RFC 3339 timestamp to minutes for display.
    return value.replace("T", " ").replace("Z", " UTC")[:19]
