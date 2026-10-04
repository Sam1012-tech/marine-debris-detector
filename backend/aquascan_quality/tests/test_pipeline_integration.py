"""End-to-end integration and JSON schema validation tests for AquaScan Quality Pipeline."""

from pathlib import Path
from unittest.mock import MagicMock

import numpy as np
import pytest

from aquascan_quality.core.pipeline_integrator import PipelineIntegrator
from aquascan_quality.core.quality_auditor import AcousticQualityAuditor


@pytest.fixture
def integrator() -> PipelineIntegrator:
    """Fixture providing a PipelineIntegrator with default config."""
    config_path = Path(__file__).resolve().parent.parent / "config" / "quality_config.yaml"
    auditor = AcousticQualityAuditor(config=config_path)
    return PipelineIntegrator(auditor=auditor)


def test_non_destructive_detection(integrator: PipelineIntegrator) -> None:
    """Verify non-destructive calibration of detections under poor data quality.

    CRITICAL PARADIGM: Under NO circumstance should poor data quality suppress,
    delete, or filter out detections. All detections MUST be retained and stamped
    with quality_warning: true and quality_note: 'low data quality'.
    """
    # Create a severely degraded tile (all black pixels = full dropout + 0 dynamic range)
    degraded_tile = np.zeros((640, 640), dtype=np.uint8)

    # Synthetic YOLO detections (naval targets)
    synthetic_detections = [
        {
            "detection_id": "a1b2c3d4",
            "class_id": 0,
            "class_name": "wreck_shipwreck",
            "confidence": 0.8842,
            "bbox_normalized": [0.4512, 0.5231, 0.2215, 0.1542],
        },
        {
            "detection_id": "e5f6a7b8",
            "class_id": 1,
            "class_name": "naval_mine",
            "confidence": 0.9215,
            "bbox_normalized": [0.1250, 0.3340, 0.0520, 0.0610],
        },
    ]

    output = integrator.process_image(
        degraded_tile,
        tile_id="sonar_track_line_042",
        synthetic_detections=synthetic_detections,
    )

    # 1. Assert quality reflects degradation
    assert output["quality"]["status"] in ("WARNING", "DEGRADED")
    assert output["quality"]["score"] < 0.75

    # 2. Assert NO detections are deleted or suppressed
    assert len(output["detections"]) == 2
    assert output["detections"][0]["class_name"] == "wreck_shipwreck"
    assert output["detections"][1]["class_name"] == "naval_mine"

    # 3. Assert calibrated non-destructive flags are attached to every detection
    for det in output["detections"]:
        assert det["quality_warning"] is True
        assert det["quality_note"] == "low data quality"


def test_passing_tile_detection_calibration(integrator: PipelineIntegrator) -> None:
    """Verify that a passing tile marks quality_warning as false and omits quality_note."""
    rng = np.random.default_rng(seed=42)
    # Healthy sonar tile
    clean_tile = rng.integers(low=50, high=180, size=(640, 640), dtype=np.uint8)

    synthetic_detections = [
        {
            "class_id": 0,
            "class_name": "wreck_shipwreck",
            "confidence": 0.95,
            "bbox_normalized": [0.5, 0.5, 0.2, 0.1],
        }
    ]

    output = integrator.process_image(
        clean_tile,
        tile_id="healthy_swath_001",
        synthetic_detections=synthetic_detections,
    )

    assert output["quality"]["status"] == "PASS"
    assert len(output["detections"]) == 1

    det = output["detections"][0]
    assert det["quality_warning"] is False
    assert "quality_note" not in det or det["quality_note"] is None


def test_json_schema_validation(integrator: PipelineIntegrator) -> None:
    """Validate that the pipeline output matches the exact JSON schema contract."""
    rng = np.random.default_rng(seed=123)
    tile = rng.integers(low=30, high=220, size=(640, 640), dtype=np.uint8)

    synthetic_detections = [
        {
            "detection_id": "8842abcd",
            "class_id": 0,
            "class_name": "wreck_shipwreck",
            "confidence": 0.8842,
            "bbox_normalized": [0.4512, 0.5231, 0.2215, 0.1542],
        }
    ]

    output = integrator.process_image(
        tile,
        tile_id="swath_tile_100",
        synthetic_detections=synthetic_detections,
    )

    # Top-level schema keys
    assert "tile_id" in output and isinstance(output["tile_id"], str)
    assert "timestamp" in output and isinstance(output["timestamp"], str)
    assert "detections" in output and isinstance(output["detections"], list)
    assert "quality" in output and isinstance(output["quality"], dict)

    # Detection item schema
    det = output["detections"][0]
    assert "detection_id" in det and len(det["detection_id"]) == 8
    assert "class_id" in det and isinstance(det["class_id"], int)
    assert "class_name" in det and isinstance(det["class_name"], str)
    assert "confidence" in det and isinstance(det["confidence"], float)
    assert "bbox_normalized" in det and len(det["bbox_normalized"]) == 4
    assert "quality_warning" in det and isinstance(det["quality_warning"], bool)

    # Quality block schema
    quality = output["quality"]
    assert "score" in quality and isinstance(quality["score"], (float, int))
    assert quality["status"] in ("PASS", "WARNING", "DEGRADED")
    assert quality["source"] == "image"
    assert "flags" in quality and isinstance(quality["flags"], list)
    assert "metrics" in quality and isinstance(quality["metrics"], dict)
    assert "config_hash" in quality and isinstance(quality["config_hash"], str)

    # Metrics schema
    metrics = quality["metrics"]
    assert "saturation_ratio" in metrics and isinstance(metrics["saturation_ratio"], float)
    assert "dropout_row_count" in metrics and isinstance(metrics["dropout_row_count"], int)
    assert "dynamic_range" in metrics and isinstance(metrics["dynamic_range"], float)


def test_ultralytics_mock_inference(integrator: PipelineIntegrator) -> None:
    """Verify end-to-end integration when using an Ultralytics-style model mock."""
    rng = np.random.default_rng(seed=321)
    tile = rng.integers(low=40, high=180, size=(640, 640), dtype=np.uint8)

    # Mock Ultralytics YOLO Results structure
    mock_boxes = MagicMock()
    mock_boxes.__len__.return_value = 1
    mock_boxes.xywhn = np.array([[0.4512, 0.5231, 0.2215, 0.1542]])
    mock_boxes.cls = np.array([0])
    mock_boxes.conf = np.array([0.8842])

    mock_result = MagicMock()
    mock_result.boxes = mock_boxes

    mock_model = MagicMock()
    mock_model.return_value = [mock_result]
    mock_model.names = {0: "wreck_shipwreck"}

    output = integrator.process_image(tile, tile_id="mock_yolo_test", model=mock_model)

    assert len(output["detections"]) == 1
    det = output["detections"][0]
    assert det["class_id"] == 0
    assert det["class_name"] == "wreck_shipwreck"
    assert det["confidence"] == 0.8842
    assert det["bbox_normalized"] == [0.4512, 0.5231, 0.2215, 0.1542]
    assert len(det["detection_id"]) == 8


def test_edge_replay_cache_contract() -> None:
    """Verify that all precomputed demo cache JSONs adhere to the edge-replay schema contract."""
    import json
    demo_cache_dir = Path(__file__).resolve().parent.parent.parent / "backend" / "demo_cache"
    assert demo_cache_dir.is_dir(), f"demo_cache dir not found at {demo_cache_dir}"

    cache_files = list(demo_cache_dir.glob("*.json"))
    assert len(cache_files) >= 6, "Expected at least 6 gallery preset cache files"

    for cache_file in cache_files:
        with open(cache_file, "r", encoding="utf-8") as f:
            data = json.load(f)

        assert "image_id" in data, f"Missing image_id in {cache_file.name}"
        assert "detections" in data and isinstance(data["detections"], list)
        assert "quality" in data and isinstance(data["quality"], dict)
        assert "processing_time_ms" in data

        # Quality block schema
        q = data["quality"]
        assert q.get("status") in ("PASS", "WARNING", "DEGRADED")
        assert "score" in q
        assert "metrics" in q
        assert "config_hash" in q

        # Detections schema
        for d in data["detections"]:
            assert "id" in d
            assert "class" in d or "class_name" in d
            assert "confidence" in d
            assert "bbox_px" in d
            assert "bbox_pct" in d
            assert "quality_warning" in d

