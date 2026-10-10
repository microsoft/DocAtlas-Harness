"""Real dependency behavior, independent of model credentials or network access."""

from __future__ import annotations

import base64
from pathlib import Path

import jwt
import pymupdf
import pytest
from pypdf import PdfWriter
from pypdf.errors import FileNotDecryptedError, PdfReadError

from docatlas.skills._common.pdf_text import get_pages_text, has_real_text, page_count

DATA = Path(__file__).resolve().parents[1] / "data"


@pytest.mark.parametrize("method", ["decode", "decode_complete"])
def test_jwt_unverified_read_cannot_disable_later_claim_validation(method: str) -> None:
    # Synthetic, expired token: no credential, Azure process, or network involved.
    key = b"offline-test-only-" * 3
    encoded = jwt.encode({"exp": 1, "sub": "synthetic"}, key, algorithm="HS256")
    options = {"verify_signature": False}
    decode = getattr(jwt, method)

    decode(encoded, options=options)

    assert options == {"verify_signature": False}
    options["verify_signature"] = True
    with pytest.raises(jwt.ExpiredSignatureError):
        decode(encoded, key, algorithms=["HS256"], options=options)
    assert options == {"verify_signature": True}


def test_jwt_deep_header_returns_decode_error_not_recursion_error() -> None:
    header = base64.urlsafe_b64encode(b"[" * 1100 + b"]" * 1100).rstrip(b"=")
    with pytest.raises(jwt.DecodeError):
        jwt.get_unverified_header(header + b".e30.")


@pytest.mark.parametrize(
    ("filename", "revenue"),
    [("sample_report.pdf", "15.2"), ("sample_report_prior.pdf", "12.6")],
)
def test_real_report_text_preserves_page_numbers_order_and_financial_values(
    filename: str, revenue: str
) -> None:
    pdf = str(DATA / filename)
    assert page_count(pdf) == 6
    pages, missing = get_pages_text(pdf, [6, 2, 1, 0, 7, 2])

    assert list(pages) == [6, 2, 1]
    assert missing == [0, 7]
    assert has_real_text(pages)
    assert "Financial Highlights" in pages[2]
    assert "Q4" in pages[2] and revenue in pages[2]
    assert "Outlook and Conclusion" in pages[6]
    for page, text in pages.items():
        assert text.startswith(f"<start_index_{page}>\n")
        assert text.endswith(f"\n<end_index_{page}>\n")
    raw, missing = get_pages_text(pdf, [2], tag=False)
    assert missing == []
    assert pages[2] == f"<start_index_2>\n{raw[2]}\n<end_index_2>\n"


def test_real_pdf_unicode_rotation_and_blank_page(tmp_path: Path) -> None:
    pdf = tmp_path / "unicode.pdf"
    with pymupdf.open() as doc:
        page = doc.new_page()
        # Embed a real Unicode map instead of depending on viewer-specific CID maps.
        font = pymupdf.Font("cjk")
        page.insert_font(fontname="test-cjk", fontbuffer=font.buffer)
        page.insert_text((72, 72), "中文证据", fontname="test-cjk")
        page.set_rotation(90)
        doc.new_page()
        doc.save(str(pdf))

    pages, missing = get_pages_text(str(pdf), [1, 2], tag=False)

    assert missing == []
    assert "中文证据" in pages[1]
    assert pages[2] == ""
    assert not has_real_text({2: pages[2]})


def test_real_pdf_text_limit_is_applied_before_page_tags(monkeypatch) -> None:
    monkeypatch.setenv("HARNESS_MAX_TEXT_CHARS_PER_PAGE", "17")
    pages, missing = get_pages_text(str(DATA / "sample_report.pdf"), [1])
    assert missing == []
    assert pages[1] == (
        "<start_index_1>\nExecutive Summary\n"
        "[Page text truncated by safety limit.]\n<end_index_1>\n"
    )


@pytest.mark.parametrize("user_password", ["", "offline-test-only"])
def test_encrypted_pdf_keeps_existing_blank_password_contract(
    tmp_path: Path, user_password: str
) -> None:
    pdf = tmp_path / "encrypted.pdf"
    with PdfWriter() as writer:
        # PdfWriter.__enter__ reinitializes the writer; append after entering.
        writer.append(str(DATA / "sample_report.pdf"))
        writer.encrypt(
            user_password,
            owner_password="test-owner-only",  # pragma: allowlist secret
            algorithm="AES-256",
        )
        writer.write(pdf)
    if user_password:
        with pytest.raises(FileNotDecryptedError):
            get_pages_text(str(pdf), [2])
    else:
        pages, missing = get_pages_text(str(pdf), [2])
        assert missing == []
        assert "Financial Highlights" in pages[2]


def test_malformed_pdf_is_not_silently_treated_as_an_empty_document(tmp_path: Path) -> None:
    pdf = tmp_path / "malformed.pdf"
    pdf.write_bytes(b"%PDF-1.7\nmalformed input\n%%EOF\n")
    with pytest.raises(PdfReadError):
        get_pages_text(str(pdf), [1])
