"""Tests for scripts/check_process_comments.py (stdlib unittest)."""

import ast
import contextlib
import io
import sys
import tempfile
import unittest
from pathlib import Path

# The sibling checker is found whether this file runs under `python -I`, which
# drops the script's own directory from sys.path, or under pytest or unittest.
sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_process_comments as checker  # noqa: E402


class ProcessIdentifierTests(unittest.TestCase):
    def test_ticket_lane_swarm_campaign_and_contract_ids_are_flagged(self):
        samples = [
            "// Ratchet (FM-046): tokens only.",
            "/* lane-E3.md reference */",
            "// lane DW owns this path",
            "// Lane F (overhaul) owns this path",
            "// swarm2 wave 4 F26",
            "// Campaign 4 decided this",
            "// NEEDS-CORE: ws.py must expose stats",
            "// contract C4: subprotocol auth",
        ]
        for sample in samples:
            with self.subTest(sample=sample):
                self.assertTrue(checker.offenders_in(sample))

    def test_survey_gap_milestone_review_and_round_codes_are_flagged(self):
        samples = [
            "// dead until col_seq crawls past 900 (survey-4 H-1).",
            "it('put validates the ask length (gap2-13)', () => {",
            "// Pre-trade (gap4-04): chips follow the locale.",
            "* Deep scroll-back history backfill (§8.3 residency, M2 T10).",
            "// T7's in-shader rescale is the exact inverse",
            "// R1-M2: same-numbered session replacement",
            "// F9-L1: the trailing seam badge",
            "// Amended R2-M1: at exactly 0.5 s",
            "// H-2: preserveDrawingBuffer keeps the old image",
            "describe('SymbolSearch chord hint (round 2)', () => {",
            "// Wave 3 / F10: the edge moved",
            "// (wave 2: no row-unit cap below the band)",
            "// QA19 H5 = 3/10 calibration",
            "// (ovl-08 / gl-21): how far past the bubble scan",
            "// (trade-03, FM-040).",
            "// Bookmap sizes dots by aggregated volume (F25, H5).",
            "// D4's d3/d4 zone",
        ]
        for sample in samples:
            with self.subTest(sample=sample):
                self.assertTrue(checker.offenders_in(sample), sample)

    def test_ordinary_english_and_ids_that_are_not_process_ids_pass(self):
        samples = [
            "// The trading lane is the one below the quote bar.",
            "// Each lane is a column of the heatmap.",
            "const laneWidth = 4; // camelCase identifiers are fine",
            "// contract details are read from the exchange feed",
            "// FM is a frame marker, not a ticket id",
            "const T0 = 1_000n; // time zero",
            "// L2 depth and L1 quotes share one ramp",
            "// the edge moved from 2.5 to 1.5 pixels per row",
            "// a 12 px label at 3 dpr",
            "// Round the value to the nearest tick",
            "// Wave-front propagation is unrelated",
        ]
        for sample in samples:
            with self.subTest(sample=sample):
                self.assertEqual(checker.offenders_in(sample), [])

    def test_offenders_carry_their_line_number(self):
        text = "clean\n// (FM-101) old\nclean\n"
        self.assertEqual(checker.offenders_in(text, "a.ts"), ["a.ts:2: // (FM-101) old"])


class ServerParityTests(unittest.TestCase):
    """The client gate and the server rule (server/tests/test_process_comments.py) share one list.

    Every server alternative must appear in SERVER_FORMS, so a new server form
    cannot land without a decision here. Each form either has a client sample
    that the client pattern flags, or is listed as a documented client exemption.
    """

    SERVER_FORMS = {
        r"FM-\d{3}": ("FM-123", True),
        r"\blanes?\b": ("lane", False),  # ordinary prose uses "lane"
        r"\blane [A-Z]{2}\b": ("lane DW", True),
        r"\bswarm\b": ("swarm", True),
        r"\bcampaign\b": ("campaign", True),
        r"NEEDS-CORE": ("NEEDS-CORE", True),
        r"\bcontract C\d": ("contract C4", True),
        r"\bsurvey-?\d": ("survey-4", True),
        r"\bgap\d-\d": ("gap2-13", True),
        r"\bcore-\d{2}\b": ("core-19", True),
        r"\bapi-\d{2}\b": ("api-02", True),
        r"\bM\d( T\d+)?\b": ("M2 T10", True),  # bare M2 counts unless it opens SVG path data
        r"\bT\d{1,2}\b": ("T7", True),  # T0 is time zero in code
        r"\bGOAL \d\b": ("GOAL 4", True),
        r"\bC\d\b": ("C4", True),
        r"\bH\d\b": ("H5", True),
        r"\bR\d-[A-Z]\d\b": ("R1-M2", True),
        r"\bQA\d+\b": ("QA3", True),
        r"\bround \d\b": ("round 2", True),
        r"\baudit FM": ("audit FM", True),
        r"\bSB item": ("SB item", True),
        r"\bSA\b": ("SA", False),  # a ladder label in the i18n tables
        r"\bSB\b": ("SB", False),  # the same label family as SA
        r"\bA\d-\d+\b": ("A1-12", True),
        r"\b[Rr]ound-?\d\b": ("round-2", True),
        r"\bR\d\b": ("R2", True),
        r"\bM-\d\b": ("M-1", True),
        r"\bwave[ -]?\d+\b": ("wave-3", True),
        r"\bwave N\b": ("wave N", True),
        r"\bF\d+/T\d+\b": ("F9/T3", True),
        r"\bgap-?\d+\b": ("gap3", False),  # bare gapN occurs in test data strings
    }

    @staticmethod
    def server_alternatives():
        source = (checker.ROOT / "server/tests/test_process_comments.py").read_text(encoding="utf-8")
        for node in ast.parse(source).body:
            if isinstance(node, ast.Assign) and any(
                isinstance(target, ast.Name) and target.id == "PROCESS_ID" for target in node.targets
            ):
                return _literal_concat(node.value.args[0]).split("|")
        raise AssertionError("server PROCESS_ID not found")

    def test_every_server_alternative_is_accounted_for(self):
        self.assertEqual(set(self.server_alternatives()), set(self.SERVER_FORMS))

    def test_client_flags_every_shared_form(self):
        for form, (sample, flagged) in self.SERVER_FORMS.items():
            if flagged:
                with self.subTest(form=form):
                    self.assertTrue(checker.PROCESS_ID.search(sample), f"{form} misses {sample!r}")

    def test_bare_milestone_mentions_are_flagged(self):
        self.assertTrue(checker.offenders_in("// see M2 for detail"))

    def test_svg_path_data_is_not_flagged(self):
        for sample in ['d="M2 3 L4 5"', 'const p = "M10,20"', 'd="M2.5 1"']:
            with self.subTest(sample=sample):
                self.assertIsNone(checker.PROCESS_ID.search(sample), sample)

    def test_client_exemptions_stay_exempt(self):
        for form, (sample, flagged) in self.SERVER_FORMS.items():
            if not flagged:
                with self.subTest(form=form):
                    self.assertIsNone(checker.PROCESS_ID.search(sample), f"{form} now flags {sample!r}")


def _literal_concat(node):
    """The text of a chain of string literals joined with ``+`` (the server's regex parts)."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        return _literal_concat(node.left) + _literal_concat(node.right)
    raise AssertionError(f"not a plain string concatenation: {ast.dump(node)}")


class ScanTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def write(self, relative, text):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def test_scans_client_source_and_tests_only(self):
        self.write("client/src/a.ts", "// FM-001 history\n")
        self.write("client/tests/e2e/b.spec.ts", "// swarm wave\n")
        self.write("server/src/c.py", "# FM-002 would be the server test's job\n")
        found = checker.scan(self.root)
        self.assertEqual(len(found), 2)
        self.assertTrue(any(line.startswith("client/src/a.ts:1") for line in found))
        self.assertTrue(any(line.startswith("client/tests/e2e/b.spec.ts:1") for line in found))

    def test_node_modules_and_dist_are_skipped(self):
        self.write("client/src/node_modules/x.ts", "// FM-003\n")
        self.write("client/src/dist/y.js", "// FM-004\n")
        self.assertEqual(checker.scan(self.root), [])

    def test_main_fails_on_an_offender_and_passes_when_clean(self):
        self.write("client/src/a.ts", "// clean comment\n")
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(checker.main(["--root", str(self.root)]), 0)
        self.write("client/src/a.ts", "// clean comment\n// (FM-005) process id\n")
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(checker.main(["--root", str(self.root)]), 1)


class RepositoryTests(unittest.TestCase):
    def test_the_repository_client_has_no_process_identifiers(self):
        found = checker.scan(checker.ROOT)
        self.assertEqual(found, [], "process identifiers in client comments:\n" + "\n".join(found))


if __name__ == "__main__":
    unittest.main()
