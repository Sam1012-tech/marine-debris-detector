"""Unit tests for AcousticQualityAuditor.

Validates pixel-domain acoustic metrics: saturation clipping, ping dropout scanlines,
dynamic range contrast floor, execution latency, and color-channel conversion.
"""

from pathlib import Path
import time

import numpy as np
import pytest

from aquascan_quality.core.quality_auditor import AcousticQualityAuditor


@pytest.fixture
def auditor() -> AcousticQualityAuditor:
    """Fixture providing an auditor loaded with the default YAML config."""
    config_path = Path(__file__).resolve().parent.parent / "config" / "quality_config.yaml"
    return AcousticQualityAuditor(config=config_path)


def test_saturation_detection(auditor: AcousticQualityAuditor) -> None:
    """Verify acoustic saturation / specular clipping detection.

    Generates a synthetic 640x640 tile with 15% pixels set to 255 (clipped).
    Asserts saturation flag is triggered, score drops below 0.75, and status is WARNING.
    """
    height, width = 640, 640
    # Create baseline image with moderate sonar backscatter (values 80..140)
    rng = np.random.default_rng(seed=42)
    img = rng.integers(low=80, high=141, size=(height, width), dtype=np.uint8)

    # Inject 15% saturated pixels (255) randomly distributed
    total_pixels = height * width
    sat_count = int(total_pixels * 0.15)
    flat_indices = rng.choice(total_pixels, size=sat_count, replace=False)
    img.reshape(-1)[flat_indices] = 255

    result = auditor.audit(img)

    # Verify saturation ratio
    assert pytest.approx(result["metrics"]["saturation_ratio"], abs=1e-3) == 0.15

    # Verify saturation flag triggered
    sat_flags = [f for f in result["flags"] if "Acoustic Clipping / Saturation" in f]
    assert len(sat_flags) == 1
    assert "15.0% > 8.0%" in sat_flags[0]

    # Verify score drops below 0.75 (penalty > 0.25)
    assert result["score"] < 0.75
    assert result["status"] in ("WARNING", "DEGRADED")


def test_dropout_detection(auditor: AcousticQualityAuditor) -> None:
    """Verify acoustic dropout & missing ping scanlines detection.

    Injects 5 completely black horizontal rows (I = 0).
    Asserts dropout count is recorded as 5, flag is appended, and penalty applied.
    """
    height, width = 640, 640
    # Standard backscatter background
    img = np.full((height, width), fill_value=100, dtype=np.uint8)

    # Inject 5 completely black rows (missing pings)
    dropout_rows = [50, 100, 200, 350, 500]
    for r in dropout_rows:
        img[r, :] = 0

    result = auditor.audit(img)

    # Verify dropout row count
    assert result["metrics"]["dropout_row_count"] == 5

    # Verify dropout flag is present
    dropout_flags = [f for f in result["flags"] if "Acoustic Dropout" in f]
    assert len(dropout_flags) == 1
    assert "5 missing ping rows detected" in dropout_flags[0]

    # Max allowed rows is 2; 5 rows triggers warning penalty
    assert result["score"] < 1.0


def test_contrast_floor(auditor: AcousticQualityAuditor) -> None:
    """Verify dynamic range & contrast floor (acoustic washout) detection.

    Generates an image with uniform Gaussian distribution I ~ N(50, 2).
    Asserts low dynamic range is flagged and flat penalty applied.
    """
    rng = np.random.default_rng(seed=123)
    # Gaussian distribution centered at 50 with std 2
    raw = rng.normal(loc=50.0, scale=2.0, size=(640, 640))
    img = np.clip(raw, 0, 255).astype(np.uint8)

    result = auditor.audit(img)

    # Dynamic range (P95 - P05) should be ~ 2 * 1.645 * 2 = 6.58 << 30.0
    assert result["metrics"]["dynamic_range"] < 30.0

    # Verify low dynamic range flag is present
    dr_flags = [f for f in result["flags"] if "Low Dynamic Range / Contrast" in f]
    assert len(dr_flags) == 1


def test_pass_clean_tile(auditor: AcousticQualityAuditor) -> None:
    """Verify that a high-quality sonar tile passes audit with zero active flags."""
    rng = np.random.default_rng(seed=999)
    # Healthy acoustic spread: values from 40 to 180 (no saturation, no black rows)
    img = rng.integers(low=40, high=180, size=(640, 640), dtype=np.uint8)

    result = auditor.audit(img)

    assert result["status"] == "PASS"
    assert result["score"] >= 0.75
    assert len(result["flags"]) == 0
    assert result["metrics"]["dropout_row_count"] == 0
    assert result["metrics"]["saturation_ratio"] == 0.0
    assert result["metrics"]["dynamic_range"] >= 30.0


def test_grayscale_conversion_3_channel(auditor: AcousticQualityAuditor) -> None:
    """Verify 3-channel color image arrays are gracefully converted to grayscale."""
    rng = np.random.default_rng(seed=777)
    # 3-channel BGR image
    bgr_img = rng.integers(low=50, high=160, size=(640, 640, 3), dtype=np.uint8)

    result = auditor.audit(bgr_img)
    assert "score" in result
    assert result["status"] == "PASS"


def test_vectorized_latency(auditor: AcousticQualityAuditor) -> None:
    """Verify all metric calculations are vectorized for < 5 ms execution per tile."""
    rng = np.random.default_rng(seed=101)
    tile = rng.integers(low=30, high=220, size=(640, 640), dtype=np.uint8)

    # Warmup
    auditor.audit(tile)

    # Measure 50 iterations
    iterations = 50
    t0 = time.perf_counter()
    for _ in range(iterations):
        auditor.audit(tile)
    t1 = time.perf_counter()

    avg_ms = ((t1 - t0) / iterations) * 1000.0
    assert avg_ms < 5.0, f"Average audit execution time {avg_ms:.2f} ms exceeds 5 ms threshold"


def test_config_hash_consistency(auditor: AcousticQualityAuditor) -> None:
    """Verify that config_hash is a 32-character hexadecimal MD5 string."""
    assert len(auditor.config_hash) == 32
    assert all(c in "0123456789abcdef" for c in auditor.config_hash)
