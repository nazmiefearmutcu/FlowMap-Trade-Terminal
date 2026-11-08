"""Static checks on the desktop webview's Content Security Policy.

The policy lives in app/src-tauri/tauri.conf.json and must stay strict: the
window runs the app's own bundled code, talks to the loopback sidecar and to
Tauri IPC, and nothing else. The sidecar port is chosen at launch, so loopback
connections allow any port on 127.0.0.1 (the session token guards them).
"""

import json
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
CONFIG = json.loads((ROOT / "app/src-tauri/tauri.conf.json").read_text(encoding="utf-8"))
CSP = CONFIG["app"]["security"]["csp"]
INDEX = (ROOT / "client/index.html").read_text(encoding="utf-8")
CLIENT_SOURCE = list((ROOT / "client/src").rglob("*.ts*"))


def directives(policy):
    """Map each directive name to its list of sources."""
    parsed = {}
    for part in policy.split(";"):
        tokens = part.split()
        if tokens:
            parsed[tokens[0]] = tokens[1:]
    return parsed


class CspTests(unittest.TestCase):
    def setUp(self):
        self.parsed = directives(CSP)

    def test_default_source_is_the_app_itself(self):
        self.assertEqual(self.parsed["default-src"], ["'self'"])

    def test_no_script_escape_hatches(self):
        for name in ("script-src", "default-src", "style-src", "worker-src"):
            with self.subTest(directive=name):
                sources = self.parsed.get(name, [])
                self.assertNotIn("'unsafe-eval'", sources)
                self.assertNotIn("'unsafe-hashes'", sources)
                self.assertNotIn("*", sources)
        self.assertEqual(self.parsed["script-src"], ["'self'"])

    def test_plugins_objects_and_base_are_closed(self):
        self.assertEqual(self.parsed["object-src"], ["'none'"])
        self.assertEqual(self.parsed["base-uri"], ["'self'"])
        self.assertEqual(self.parsed["frame-src"], ["'none'"])
        self.assertEqual(self.parsed["form-action"], ["'none'"])

    def test_fonts_come_from_the_bundle_only(self):
        self.assertEqual(self.parsed["font-src"], ["'self'"])
        self.assertNotIn("data:", self.parsed["font-src"])

    def test_no_media_is_loaded(self):
        self.assertEqual(self.parsed["media-src"], ["'none'"])

    def test_connections_reach_only_ipc_and_the_loopback_sidecar(self):
        sources = self.parsed["connect-src"]
        self.assertIn("ipc:", sources)
        self.assertIn("http://127.0.0.1:*", sources)
        self.assertIn("ws://127.0.0.1:*", sources)
        for source in sources:
            with self.subTest(source=source):
                if source.startswith(("http://", "https://", "ws://", "wss://")):
                    self.assertTrue(source.startswith(("http://127.0.0.1:", "http://ipc.localhost", "ws://127.0.0.1:")),
                                    f"non-loopback origin in connect-src: {source}")

    def test_every_directive_is_known(self):
        known = {
            "default-src", "script-src", "style-src", "img-src", "font-src", "media-src",
            "worker-src", "connect-src", "frame-src", "object-src", "base-uri", "form-action",
        }
        self.assertLessEqual(set(self.parsed), known)


class ClientLoadsNothingExternal(unittest.TestCase):
    URL = re.compile(r"""(?:src|href)\s*=\s*["'](https?:|//)[^"']*""", re.IGNORECASE)

    def test_index_html_references_no_remote_origin(self):
        self.assertIsNone(self.URL.search(INDEX))

    def test_the_client_source_fetches_no_remote_font_or_script(self):
        for path in CLIENT_SOURCE:
            text = path.read_text(encoding="utf-8")
            with self.subTest(file=str(path.relative_to(ROOT))):
                self.assertNotIn("fonts.googleapis.com", text)
                self.assertNotIn("fonts.gstatic.com", text)
                self.assertIsNone(re.search(r"import\(\s*['\"]https?:", text))


if __name__ == "__main__":
    unittest.main()
