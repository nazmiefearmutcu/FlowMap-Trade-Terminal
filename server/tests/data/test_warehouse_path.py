"""The intelligence warehouse resolves its default location absolutely. A "~"
value expands to the user's home instead of creating a literal "~" folder under
the working directory, and an unset value never lands in the launch directory."""

from __future__ import annotations

from flowmap_server.data.warehouse import DuckWarehouse


def _point_home_at(monkeypatch, home):
    # Path.expanduser reads HOME on POSIX and USERPROFILE on Windows.
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))


def test_tilde_data_dir_expands_to_the_profile_not_a_literal_folder(tmp_path, monkeypatch):
    home = tmp_path / "home"
    cwd = tmp_path / "launch"
    home.mkdir()
    cwd.mkdir()
    _point_home_at(monkeypatch, home)
    monkeypatch.chdir(cwd)
    monkeypatch.setenv("FLOWMAP_DATA_DIR", "~/fm-data")
    warehouse = DuckWarehouse()
    try:
        assert (home / "fm-data" / "warehouse.duckdb").exists()
        assert not (cwd / "~").exists()
    finally:
        warehouse.close()


def test_unset_data_dir_is_not_relative_to_the_launch_directory(tmp_path, monkeypatch):
    home = tmp_path / "home"
    cwd = tmp_path / "launch"
    home.mkdir()
    cwd.mkdir()
    _point_home_at(monkeypatch, home)
    monkeypatch.chdir(cwd)
    monkeypatch.delenv("FLOWMAP_DATA_DIR", raising=False)
    warehouse = DuckWarehouse()
    try:
        assert not (cwd / ".flowmap_data").exists()
        assert (home / ".flowmap" / "intelligence" / "warehouse.duckdb").exists()
    finally:
        warehouse.close()
