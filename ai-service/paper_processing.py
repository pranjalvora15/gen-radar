from pathlib import Path
from typing import BinaryIO

from pypdf import PdfReader

from models import PaperPage


class PaperValidationError(ValueError):
    pass


def clean_pdf_text(value: str) -> str:
    # PostgreSQL TEXT cannot contain NUL. Some PDF font/layout encodings emit
    # it even though the visible document is valid.
    return value.replace("\x00", "")


def inspect_pdf(source: Path | BinaryIO, max_pages: int = 150) -> tuple[str, list[PaperPage], str]:
    try:
        if hasattr(source, "seek"):
            source.seek(0)
        reader = PdfReader(source, strict=False)
    except Exception as error:
        raise PaperValidationError("The uploaded PDF is malformed or unreadable") from error

    if reader.is_encrypted:
        raise PaperValidationError("Encrypted PDFs are not supported")
    if not reader.pages:
        raise PaperValidationError("The PDF does not contain any pages")
    if len(reader.pages) > max_pages:
        raise PaperValidationError(f"PDFs may contain at most {max_pages} pages")

    pages: list[PaperPage] = []
    for index, page in enumerate(reader.pages, start=1):
        try:
            text = page.extract_text(extraction_mode="layout") or ""
        except TypeError:
            text = page.extract_text() or ""
        except Exception:
            text = ""
        cleaned = "\n".join(
            line.rstrip() for line in clean_pdf_text(text).splitlines()
        ).strip()
        pages.append(PaperPage(pageNumber=index, text=cleaned))

    total_characters = sum(len(page.text) for page in pages)
    useful_pages = sum(1 for page in pages if len(page.text) >= 80)
    if total_characters < 500 or useful_pages < max(1, min(3, len(pages) // 4)):
        raise PaperValidationError(
            "This PDF does not contain enough selectable text; scanned PDFs are not supported"
        )

    metadata_title = ""
    try:
        metadata_title = (
            clean_pdf_text(reader.metadata.title or "").strip()
            if reader.metadata else ""
        )
    except Exception:
        metadata_title = ""
    first_lines = [line.strip() for line in pages[0].text.splitlines() if line.strip()]
    title = metadata_title or (first_lines[0][:500] if first_lines else "Untitled AI paper")

    selected_pages = pages[:4]
    if len(pages) > 6:
        selected_pages += pages[-2:]
    sample = "\n\n".join(
        f"PAGE {page.page_number}:\n{page.text[:4_000]}" for page in selected_pages
    )[:20_000]
    return title[:500], pages, sample
