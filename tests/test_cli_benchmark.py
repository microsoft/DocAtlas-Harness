from __future__ import annotations

import pytest

from scripts import benchmark_cli


def test_measure_separates_first_run_from_warm_samples(monkeypatch) -> None:
    clock = iter([0, 5, 5, 6, 6, 8])
    monkeypatch.setattr(benchmark_cli.time, "perf_counter", lambda: next(clock))
    report = benchmark_cli.measure(lambda: {"same": "bytes"}, 3)
    assert report == {
        "result": {"same": "bytes"},
        "seconds": [5, 1, 2],
        "median_seconds": 2,
        "warm_median_seconds": 1.5,
    }


@pytest.mark.parametrize("first", [None, "original", {"hash": "original"}])
def test_measure_rejects_non_deterministic_results(first) -> None:
    results = iter([first, "changed"])
    with pytest.raises(ValueError, match="non-deterministic"):
        benchmark_cli.measure(lambda: next(results), 2)


@pytest.mark.parametrize("count", [0, -1])
def test_measure_rejects_empty_or_negative_sample_counts(count: int) -> None:
    with pytest.raises(ValueError, match="positive"):
        benchmark_cli.measure(lambda: None, count)


def test_single_sample_cannot_claim_a_warm_median() -> None:
    report = benchmark_cli.measure(lambda: None, 1)
    assert report["result"] is None
    assert report["warm_median_seconds"] is None


def test_absent_distribution_is_reported_not_hidden(monkeypatch) -> None:
    def missing(name):
        raise benchmark_cli.importlib.metadata.PackageNotFoundError(name)

    monkeypatch.setattr(benchmark_cli.importlib.metadata, "version", missing)
    assert benchmark_cli.package_version("absent") is None


def test_benchmark_never_overwrites_an_existing_report(tmp_path, monkeypatch) -> None:
    report = tmp_path / "report.json"
    report.write_text("original evidence", encoding="utf-8")
    monkeypatch.setattr(benchmark_cli.sys, "argv", ["benchmark_cli", "--output", str(report)])
    monkeypatch.setattr(benchmark_cli.os, "environ", benchmark_cli.os.environ.copy())
    with pytest.raises(FileExistsError):
        benchmark_cli.main()
    assert report.read_text() == "original evidence"
