#!/usr/bin/env python3
"""
Generate the real-document extraction validation set.

Every file is produced by a *different* generator so the hand-written Worker
parsers are exercised against genuinely varied PDF/OOXML structures rather than
one library's output shape:

  PDF   reportlab (base-14 fonts)      — literal WinAnsi strings
        PyMuPDF                        — different writer, own text operators
        LibreOffice                    — office-produced, embedded font subset
        reportlab + embedded TTF       — CID/Unicode font (stress case)
        PIL image-only                 — scanned page, NO text layer
  DOCX  python-docx                    — headings, list, table
        hand-built OOXML zip           — minimal container, raw path
  PPTX  python-pptx (slides + notes)   — multi-slide ordering
        python-pptx (table slide)      — graphicFrame/table content

A JSON manifest is written alongside the fixtures describing each file, the
generator that produced it and what the extractor is expected to recover. The
validation runner (scripts/validate-extraction.mjs) asserts against it.

Usage:  python3 scripts/gen-extraction-fixtures.py [outdir]   (default /tmp/val)
"""

import json
import os
import subprocess
import sys
import zipfile

OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/val"

# Distinct topics make the set useful for semantic testing too: a query like
# "financial performance" should match the finance document without the exact word.
FINANCE = [
    "Quarterly Revenue Report",
    "Consolidated earnings rose sharply this period, with gross margin expanding",
    "to 42 percent as operating costs stayed flat. Free cash flow generation was",
    "strong and the balance sheet carries no net debt. Management reaffirmed",
    "full-year guidance and flagged continued investment in distribution.",
]
ENGINEERING = [
    "Platform Migration Notes",
    "We completed the container orchestration cutover last weekend. Peak p99",
    "latency dropped from 480ms to 210ms after right-sizing the scheduler pools.",
    "Rollback is a single helm revision; the blue-green switch is fully automated.",
]
LEGAL = [
    "Data Processing Agreement",
    "This addendum governs personal data retention, sub-processor disclosure and",
    "cross-border transfer safeguards. Either party may audit compliance annually",
    "with thirty days written notice. Deletion follows termination within 90 days.",
]


def ensure(path):
    os.makedirs(path, exist_ok=True)


def w(path, data):
    with open(path, "wb") as fh:
        fh.write(data if isinstance(data, bytes) else data.encode("utf-8"))


manifest = []


def record(name, generator, kind, expect, contains=None, note=""):
    manifest.append(
        {
            "file": name,
            "generator": generator,
            "kind": kind,
            "expect": expect,  # "text" | "no-text" | "maybe"
            "expectContains": contains or [],
            "note": note,
        }
    )


# ---------------------------------------------------------------- PDFs

def pdf_reportlab_standard(path):
    from reportlab.lib.pagesizes import LETTER
    from reportlab.pdfgen import canvas

    c = canvas.Canvas(path, pagesize=LETTER)
    y = 740
    for line in FINANCE:
        c.drawString(72, y, line)
        y -= 20
    c.showPage()
    c.save()


def pdf_reportlab_unicode(path):
    """Embedded TrueType → CID font. This is the honest stress case."""
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.lib.pagesizes import LETTER
    from reportlab.pdfgen import canvas

    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ]
    font_path = next((p for p in candidates if os.path.exists(p)), None)
    if not font_path:
        raise RuntimeError("no TTF available for the embedded-font case")

    pdfmetrics.registerFont(TTFont("Embedded", font_path))
    c = canvas.Canvas(path, pagesize=LETTER)
    c.setFont("Embedded", 12)
    y = 740
    for line in ENGINEERING:
        c.drawString(72, y, line)
        y -= 20
    # Non-Latin and accented content forces a CID-encoded font program.
    c.drawString(72, y, "Ünïcödé: café — naïve — 東京 — ₹1,250")
    c.showPage()
    c.save()


def pdf_pymupdf(path):
    import pymupdf

    doc = pymupdf.open()
    page = doc.new_page()
    y = 72
    for line in LEGAL:
        page.insert_text((72, y), line, fontsize=11)
        y += 18
    doc.save(path)
    doc.close()


def pdf_via_libreoffice(src_docx, outdir, path):
    subprocess.run(
        ["soffice", "--headless", "--convert-to", "pdf", "--outdir", outdir, src_docx],
        check=True,
        capture_output=True,
        timeout=180,
    )
    produced = os.path.join(outdir, os.path.splitext(os.path.basename(src_docx))[0] + ".pdf")
    if os.path.exists(produced) and produced != path:
        os.replace(produced, path)


def pdf_scanned(path):
    """Image-only PDF: text is rasterised, so there is no text layer at all."""
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("RGB", (1240, 1754), "white")  # A4 at 150dpi
    draw = ImageDraw.Draw(img)
    font = None
    for cand in [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ]:
        if os.path.exists(cand):
            font = ImageFont.truetype(cand, 34)
            break
    if font is None:
        font = ImageFont.load_default()

    y = 160
    for line in FINANCE:
        draw.text((110, y), line, fill="black", font=font)
        y += 52
    # Scanner-style skew/noise so it reads as a real scan, not a clean render.
    img = img.rotate(-0.35, expand=False, fillcolor="white")
    img.save(path, "PDF", resolution=150.0)


# ---------------------------------------------------------------- DOCX

def docx_python_docx(path):
    from docx import Document
    from docx.shared import Pt

    d = Document()
    d.add_heading("Onboarding Policy", level=1)
    d.add_paragraph(
        "Every new colleague receives a laptop, a security key and access to the "
        "internal handbook on their first morning."
    )
    d.add_heading("Checklist", level=2)
    for item in [
        "Sign the acceptable use agreement",
        "Enrol the hardware security key",
        "Complete the data handling briefing",
    ]:
        d.add_paragraph(item, style="List Bullet")

    table = d.add_table(rows=3, cols=2)
    table.cell(0, 0).text = "Stage"
    table.cell(0, 1).text = "Owner"
    table.cell(1, 0).text = "Provisioning"
    table.cell(1, 1).text = "IT operations"
    table.cell(2, 0).text = "Security briefing"
    table.cell(2, 1).text = "Compliance"
    d.styles["Normal"].font.size = Pt(11)
    d.save(path)


def docx_raw_ooxml(path):
    """Hand-built container — bypasses python-docx's serializer entirely."""
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        "</Types>"
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        "</Relationships>"
    )
    lines = [
        "Minimal Specification",
        "The ingestion endpoint accepts a single multipart body with a declared",
        "content type and a checksum. Text is extracted in the same request so the",
        "artifact is searchable immediately after it is stored.",
    ]
    paras = "".join(
        f'<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>{l}</w:t></w:r></w:p>'
        if i == 0
        else f"<w:p><w:r><w:t>{l}</w:t></w:r></w:p>"
        for i, l in enumerate(lines)
    )
    # A run split mid-sentence, which must NOT fuse words in the output.
    paras += (
        "<w:p>"
        "<w:r><w:t>Quarterly</w:t></w:r>"
        "<w:r><w:t xml:space=\"preserve\"> Revenue</w:t></w:r>"
        "<w:r><w:t xml:space=\"preserve\"> was up.</w:t></w:r>"
        "<w:r><w:br/></w:r>"
        "<w:r><w:t>Second line after a break.</w:t></w:r>"
        "<w:r><w:tab/></w:r>"
        "<w:r><w:t>Tabbed cell.</w:t></w:r>"
        "<w:r><w:t>Escaped &amp; ampersand &lt;tag&gt;.</w:t></w:r>"
        "</w:p>"
    )
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body>{paras}</w:body></w:document>"
    )
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", rels)
        z.writestr("word/document.xml", document)


# ---------------------------------------------------------------- PPTX

def pptx_slides_with_notes(path):
    from pptx import Presentation

    prs = Presentation()
    slides = [
        ("Product Roadmap", ["Q3: unified search", "Q4: offline capture", "Q1: team analytics"]),
        ("Delivery", ["Two-week cadence", "Feature flags on every release", "Automated rollback"]),
        ("Risks", ["Index growth outpaces retention policy", "Vendor dependency on embeddings"]),
    ]
    for title, bullets in slides:
        slide = prs.slides.add_slide(prs.slide_layouts[1])
        slide.shapes.title.text = title
        body = slide.placeholders[1].text_frame
        body.text = bullets[0]
        for b in bullets[1:]:
            body.add_paragraph().text = b
        slide.notes_slide.notes_text_frame.text = f"Speaker notes for {title}: cover the trade-offs."

    first = prs.slides[0]
    slide = prs.slides.add_slide(prs.slide_layouts[5])
    slide.shapes.title.text = "Adoption Metrics"
    rows, cols = 3, 2
    table = slide.shapes.add_table(rows, cols, 60, 160, 600, 160).table
    table.cell(0, 0).text = "Metric"
    table.cell(0, 1).text = "Value"
    table.cell(1, 0).text = "Weekly active creators"
    table.cell(1, 1).text = "4,180"
    table.cell(2, 0).text = "Artifacts stored"
    table.cell(2, 1).text = "128,904"
    assert first is not None
    prs.save(path)


def pptx_table_focus(path):
    from pptx import Presentation

    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[5])
    slide.shapes.title.text = "Regional Sales"
    table = slide.shapes.add_table(4, 3, 50, 150, 680, 220).table
    data = [
        ["Region", "Revenue", "Growth"],
        ["North", "1,240,000", "18%"],
        ["South", "980,500", "11%"],
        ["East", "1,610,750", "24%"],
    ]
    for r, row in enumerate(data):
        for c, val in enumerate(row):
            table.cell(r, c).text = val
    prs.save(path)


# ---------------------------------------------------------------- main

def main():
    ensure(OUT)
    print(f"writing fixtures to {OUT}\n")

    # --- PDFs -------------------------------------------------------
    p = os.path.join(OUT, "finance-reportlab.pdf")
    pdf_reportlab_standard(p)
    record(p and os.path.basename(p), "reportlab (base-14)", "pdf", "text", ["Quarterly Revenue Report", "margin"])

    p = os.path.join(OUT, "legal-pymupdf.pdf")
    pdf_pymupdf(p)
    record(os.path.basename(p), "PyMuPDF", "pdf", "text", ["Data Processing Agreement", "sub-processor"])

    p = os.path.join(OUT, "unicode-embedded-ttf.pdf")
    pdf_reportlab_unicode(p)
    record(
        os.path.basename(p),
        "reportlab (embedded TTF / CID)",
        "pdf",
        "maybe",
        [],
        "CID-encoded font program — hand-written parser may not decode it",
    )

    # --- DOCX (needed before the LibreOffice conversion) ------------
    docx_a = os.path.join(OUT, "onboarding-python-docx.docx")
    docx_python_docx(docx_a)
    record(os.path.basename(docx_a), "python-docx", "docx", "text", ["Onboarding Policy", "hardware security key"])

    docx_b = os.path.join(OUT, "spec-raw-ooxml.docx")
    docx_raw_ooxml(docx_b)
    record(
        os.path.basename(docx_b),
        "hand-built OOXML zip",
        "docx",
        "text",
        ["Minimal Specification", "Quarterly Revenue was up.", "Escaped & ampersand"],
    )

    p = os.path.join(OUT, "onboarding-libreoffice.pdf")
    try:
        pdf_via_libreoffice(docx_a, OUT, p)
        record(os.path.basename(p), "LibreOffice", "pdf", "text", ["Onboarding Policy"], "converted from DOCX")
    except Exception as exc:  # noqa: BLE001
        print(f"  !! libreoffice conversion failed: {exc}")

    # --- PPTX -------------------------------------------------------
    p = os.path.join(OUT, "roadmap-python-pptx.pptx")
    pptx_slides_with_notes(p)
    record(
        os.path.basename(p),
        "python-pptx (slides + notes)",
        "pptx",
        "text",
        ["Product Roadmap", "Speaker notes for Risks", "unified search"],
    )

    p = os.path.join(OUT, "sales-table-pptx.pptx")
    pptx_table_focus(p)
    record(os.path.basename(p), "python-pptx (table)", "pptx", "text", ["Regional Sales", "1,610,750"])

    # --- scanned ----------------------------------------------------
    p = os.path.join(OUT, "scanned-finance.pdf")
    pdf_scanned(p)
    record(
        os.path.basename(p),
        "PIL image-only",
        "pdf",
        "no-text",
        [],
        "scanned page — must report PARTIAL/no text layer, never invent text",
    )

    with open(os.path.join(OUT, "manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=2)

    for entry in manifest:
        size = os.path.getsize(os.path.join(OUT, entry["file"]))
        print(f"  {entry['file']:<32} {entry['generator']:<32} {size:>8,} bytes")
    print(f"\n{len(manifest)} fixtures + manifest.json")


if __name__ == "__main__":
    main()
