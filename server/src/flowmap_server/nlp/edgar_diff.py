"""SEC EDGAR Item 1A text differences and literal keyword matches (DOCS <GO>).

Describes SEC EDGAR corporate filings without assessing materiality:
- Extracts Item 1A. Risk Factors sections from already-extracted plain text (no
  HTML parsing is done here).
- Splits each section into sentences and computes insertions and deletions with
  difflib.unified_diff.
- Flags literal keyword matches from this list:
  "DOJ", "investigation", "subpoena", "material weakness", "restatement",
  "sanctions", "default", "whistleblower", "litigation".
"""

from __future__ import annotations

import difflib
import logging
import re
from typing import Any

log = logging.getLogger(__name__)

CRITICAL_TRIGGER_TERMS = [
    "doj",
    "department of justice",
    "investigation",
    "subpoena",
    "sec probe",
    "material weakness",
    "restatement",
    "whistleblower",
    "sanctions",
    "default",
    "going concern",
    "litigation",
]


# A heading starts a line, like the Item headings that end a section. A mid-line
# cross reference such as "Refer to Item 1A. Risk Factors" is prose: as a heading
# it would win the longest-body rule and return the MD&A text that follows it.
_RISK_HEADER = re.compile(r"^[^\S\r\n]*item\s+1a\b[.\s:-]*risk\s+factors\b", re.IGNORECASE | re.MULTILINE)
# A section ends at the next Item heading that starts a line. An inline cross
# reference such as "see Item 7" is part of the sentence and must not end it.
_NEXT_ITEM = re.compile(r"^[^\S\r\n]*item\s+\d+[a-z]?\b[.\s:-]", re.IGNORECASE | re.MULTILINE)


def _section_body(document_text: str, header: re.Match[str]) -> str:
    tail = document_text[header.end():]
    following_item = _NEXT_ITEM.search(tail)
    return tail[:following_item.start()].strip() if following_item else tail.strip()


def extract_risk_factors(document_text: str) -> str:
    """Extract Item 1A. Risk Factors text from a 10-K or 10-Q filing text.

    A filing states the Item 1A heading twice: once in the table of contents and
    once above the body. Every heading is tried and the longest body wins, so a
    table-of-contents line (a heading followed directly by the next Item) can
    never stand in for the section.
    """
    best = ""
    for header in _RISK_HEADER.finditer(document_text):
        body = _section_body(document_text, header)
        if len(body) > len(best):
            best = body
    return best


def _sentences(text: str) -> list[str]:
    """Sentence-level units for diffing: sentence ends and line breaks both split."""
    return [part.strip() for part in re.split(r"(?<=[.!?])\s+|\n+", text) if part.strip()]


def compute_risk_delta(prev_text: str, curr_text: str) -> dict[str, Any]:
    """Compare Item 1A sections in full filing texts using a keyword heuristic.

    Neither keyword matches nor line counts establish a material change. The
    legacy ``is_material_change`` key remains false; use ``has_keyword_matches``
    for the descriptive flag. Missing either section makes comparison unavailable.
    """
    previous = extract_risk_factors(prev_text)
    current = extract_risk_factors(curr_text)
    available = bool(previous and current)
    prev_units = _sentences(previous) if available else []
    curr_units = _sentences(current) if available else []

    differ = difflib.unified_diff(
        prev_units, curr_units, lineterm="", fromfile="Previous", tofile="Current"
    )

    added_sentences: list[str] = []
    deleted_sentences: list[str] = []

    for line in differ:
        if line.startswith("+") and not line.startswith("+++"):
            cleaned = line[1:].strip()
            if len(cleaned) > 15:
                added_sentences.append(cleaned)
        elif line.startswith("-") and not line.startswith("---"):
            cleaned = line[1:].strip()
            if len(cleaned) > 15:
                deleted_sentences.append(cleaned)

    # Literal matches only: this does not classify risk, severity or materiality.
    critical_flags: list[str] = []
    for added in added_sentences:
        lower_sent = added.lower()
        for term in CRITICAL_TRIGGER_TERMS:
            if re.search(r"\b" + re.escape(term) + r"\b", lower_sent):
                critical_flags.append(f"Literal keyword match: '{term}' in added text: {added[:120]}")

    return {
        "added_count": len(added_sentences),
        "deleted_count": len(deleted_sentences),
        "added_samples": added_sentences[:10],
        "deleted_samples": deleted_sentences[:10],
        "critical_flags": list(dict.fromkeys(critical_flags)),
        "available": available,
        "unavailable_reason": None if available else "Item 1A Risk Factors section missing or empty",
        "method": "literal keyword heuristic on Item 1A text; not a materiality assessment",
        "has_keyword_matches": bool(critical_flags),
        "materiality_assessed": False,
        "is_material_change": False,
    }
