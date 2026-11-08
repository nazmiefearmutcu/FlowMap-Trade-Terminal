"""Server-side symbol search matches the client's Unicode-normalized searchKey.

The directory filter lives in ``data/universe.py``; these tests pin the same
behaviour the client pins in ``client/src/ui/symbols.search.test.ts``.
"""

from flowmap_server.data.universe import filter_directory, search_key

DIRECTORY = (
    {"market": "sim", "symbol": "SIM-DEMO", "capability": {}},
    {"market": "equity", "symbol": "CAFÉ", "capability": {}},
    {"market": "equity", "symbol": "İZMİR", "capability": {}},
    {"market": "binance-usdm", "symbol": "BTCUSDT", "capability": {}},
)


def _symbols(q: str) -> list[str]:
    return [str(e["symbol"]) for e in filter_directory(DIRECTORY, q=q)]


def test_search_key_drops_combining_marks_and_lowercases():
    assert search_key("CAFÉ") == search_key("CAFÉ") == "cafe"


def test_search_key_folds_turkish_dotted_capital_i_onto_plain_i():
    assert search_key("İz") == "iz"


def test_decomposed_query_matches_a_composed_symbol():
    assert _symbols("café") == ["CAFÉ"]


def test_plain_query_matches_a_dotted_capital_i_symbol():
    assert _symbols("iz") == ["İZMİR"]


def test_ascii_matching_is_unchanged_and_case_insensitive():
    assert _symbols("btc") == ["BTCUSDT"]
    assert _symbols("SIM") == ["SIM-DEMO"]


def test_whitespace_only_query_lists_everything_like_the_client():
    assert len(filter_directory(DIRECTORY, q="   ")) == len(DIRECTORY)


def test_bundled_crypto_shortlist_uses_the_trading_binance_spellings():
    # Binance exchangeInfo (checked against the live API): MATICUSDT and FTMUSDT
    # were in BREAK status, while their successors POLUSDT and SUSDT were TRADING.
    from flowmap_server.data.universe import CRYPTO_SYMBOLS

    assert "MATICUSDT" not in CRYPTO_SYMBOLS and "FTMUSDT" not in CRYPTO_SYMBOLS
    assert {"POLUSDT", "SUSDT"} <= set(CRYPTO_SYMBOLS)
