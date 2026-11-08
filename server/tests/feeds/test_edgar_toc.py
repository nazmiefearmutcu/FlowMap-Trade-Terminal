"""Item 1A extraction must read the filing body, not its table of contents."""

from flowmap_server.nlp.edgar_diff import compute_risk_delta, extract_risk_factors

TOC_THEN_BODY = (
    "TABLE OF CONTENTS\n"
    "Item 1. Business 4\n"
    "Item 1A. Risk Factors 15\n"
    "Item 1B. Unresolved Staff Comments 30\n"
    "\n"
    "PART I\n"
    "Item 1. Business\n"
    "We sell industrial sensors to manufacturers.\n"
    "Item 1A. Risk Factors\n"
    "We depend on a small number of suppliers for chips.\n"
    "Item 1B. Unresolved Staff Comments\n"
    "None.\n"
)


def test_table_of_contents_match_does_not_stand_in_for_the_body():
    assert extract_risk_factors(TOC_THEN_BODY) == "We depend on a small number of suppliers for chips."


def test_inline_item_cross_reference_does_not_end_the_section():
    filing = (
        "Item 1A. Risk Factors\n"
        "Our results are described in more detail in see Item 7 of this report. "
        "We depend on a small number of suppliers.\n"
        "Item 1B. Unresolved Staff Comments\n"
    )
    body = extract_risk_factors(filing)
    assert "We depend on a small number of suppliers." in body
    assert body.startswith("Our results are described")


def test_a_mid_line_item_1a_cross_reference_never_stands_in_for_the_section():
    # Item 7 points at Item 1A mid-sentence, and the prose after it is longer
    # than the real section. Only a heading that starts a line may count.
    filing = (
        "Item 1A. Risk Factors\n"
        "We depend on a small number of suppliers.\n"
        "Item 1B. Unresolved Staff Comments\n"
        "None.\n"
        "Item 7. Management Discussion\n"
        "Refer to Item 1A. Risk Factors for the complete list of risks. "
        + ("Long MD&A text that keeps going. " * 40) + "\n"
        "Item 8. Financial Statements\n"
    )
    assert extract_risk_factors(filing) == "We depend on a small number of suppliers."


def test_a_non_breaking_space_before_the_heading_still_counts_as_line_start():
    filing = (
        " Item 1A. Risk Factors\n"
        "We depend on a small number of suppliers.\n"
        " Item 1B. Unresolved Staff Comments\n"
    )
    assert extract_risk_factors(filing) == "We depend on a small number of suppliers."


def test_risk_diff_on_full_filings_compares_body_text_not_page_numbers():
    previous = TOC_THEN_BODY
    current = TOC_THEN_BODY.replace(
        "We depend on a small number of suppliers for chips.\n",
        "We depend on a small number of suppliers for chips.\n"
        "We received a subpoena from a federal agency.\n",
    )
    result = compute_risk_delta(previous, current)
    assert result["available"] is True
    assert result["added_count"] == 1
    assert result["deleted_count"] == 0
    assert result["added_samples"] == ["We received a subpoena from a federal agency."]
    assert any("'subpoena'" in flag for flag in result["critical_flags"])
