"""AquaScan Pipeline Integrator and Metadata Calibration Orchestrator.

Fuses pixel-domain acoustic quality audit metrics with object detection bounding boxes
under a strict non-destructive auditing philosophy.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Union
import uuid

import numpy as np

from .quality_auditor import AcousticQualityAuditor


class PipelineIntegrator:
    """Orchestrates image quality auditing and YOLO object detection fusion."""

    def __init__(
        self,
        config: Union[Dict[str, Any], str, Path, None] = None,
        model: Any = None,
        auditor: Optional[AcousticQualityAuditor] = None,
    ) -> None:
        """Initialize the pipeline integrator.

        Args:
            config: Configuration dictionary or path for the auditor.
            model: Optional YOLO model instance, weights path, or mock detector.
            auditor: Optional pre-configured AcousticQualityAuditor instance.
        """
        self.auditor = auditor if auditor is not None else AcousticQualityAuditor(config=config)
        self.model = self._init_model(model)

    @staticmethod
    def _init_model(model_input: Any) -> Any:
        """Initialize the object detector model if a weights path is provided."""
        if model_input is None:
            return None

        if isinstance(model_input, (str, Path)):
            model_path = Path(model_input)
            if model_path.is_file():
                try:
                    from ultralytics import YOLO

                    return YOLO(str(model_path))
                except ImportError:
                    return None
            return None

        # Already an instantiated model or mock
        return model_input

    def _extract_yolo_detections(
        self,
        model: Any,
        image_input: Union[np.ndarray, str, Path],
    ) -> List[Dict[str, Any]]:
        """Run YOLO inference and extract normalized detections."""
        if model is None:
            return []

        # If model is a callable or mock that returns custom detection dicts directly
        if callable(model) and not hasattr(model, "predict") and not hasattr(model, "names"):
            custom_out = model(image_input)
            if isinstance(custom_out, list):
                return custom_out

        # Standard Ultralytics YOLO inference
        try:
            results = model(image_input, verbose=False)
        except TypeError:
            results = model(image_input)

        extracted: List[Dict[str, Any]] = []

        for result in results:
            boxes = getattr(result, "boxes", None)
            if boxes is None or len(boxes) == 0:
                continue

            # Model class names lookup
            names = getattr(model, "names", getattr(result, "names", {}))

            xywhn_data = boxes.xywhn
            if hasattr(xywhn_data, "cpu"):
                xywhn_data = xywhn_data.cpu().numpy()
            elif hasattr(xywhn_data, "numpy"):
                xywhn_data = xywhn_data.numpy()

            cls_data = boxes.cls
            if hasattr(cls_data, "cpu"):
                cls_data = cls_data.cpu().numpy()
            elif hasattr(cls_data, "numpy"):
                cls_data = cls_data.numpy()

            conf_data = boxes.conf
            if hasattr(conf_data, "cpu"):
                conf_data = conf_data.cpu().numpy()
            elif hasattr(conf_data, "numpy"):
                conf_data = conf_data.numpy()

            for i in range(len(boxes)):
                cls_id = int(cls_data[i])
                if isinstance(names, dict):
                    cls_name = names.get(cls_id, str(cls_id))
                elif isinstance(names, (list, tuple)) and cls_id < len(names):
                    cls_name = str(names[cls_id])
                else:
                    cls_name = str(cls_id)

                conf = round(float(conf_data[i]), 4)
                bbox_norm = [round(float(coord), 4) for coord in xywhn_data[i].tolist()]

                extracted.append(
                    {
                        "detection_id": uuid.uuid4().hex[:8],
                        "class_id": cls_id,
                        "class_name": cls_name,
                        "confidence": conf,
                        "bbox_normalized": bbox_norm,
                    }
                )

        return extracted

    @staticmethod
    def _calibrate_detections(
        detections: List[Dict[str, Any]],
        quality_status: str,
    ) -> List[Dict[str, Any]]:
        """Apply non-destructive data quality stamping to predicted bounding boxes.

        CRITICAL PARADIGM:
        Every incoming detection is preserved. Under poor data quality, detections are
        stamped with a 'quality_warning' and a 'quality_note' without filtering or deletion.
        """
        calibrated: List[Dict[str, Any]] = []
        is_low_quality = quality_status != "PASS"

        for det in detections:
            # Copy to avoid side-effects
            item = dict(det)

            # Ensure detection_id exists
            if "detection_id" not in item:
                item["detection_id"] = uuid.uuid4().hex[:8]

            if is_low_quality:
                item["quality_warning"] = True
                item["quality_note"] = "low data quality"
            else:
                item["quality_warning"] = False
                # Omit quality_note or set to None per schema specification
                item.pop("quality_note", None)

            calibrated.append(item)

        return calibrated

    def run_audited_inference(
        self,
        image_input: Union[np.ndarray, str, Path],
        tile_id: Optional[str] = None,
        timestamp: Optional[str] = None,
        model: Any = None,
        synthetic_detections: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """Alias for process_image for API integration compatibility."""
        return self.process_image(
            image_input=image_input,
            tile_id=tile_id,
            timestamp=timestamp,
            model=model,
            synthetic_detections=synthetic_detections,
        )

    def process_image(
        self,
        image_input: Union[np.ndarray, str, Path],
        tile_id: Optional[str] = None,
        timestamp: Optional[str] = None,
        model: Any = None,
        synthetic_detections: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """Process an image tile: audit quality, run YOLO inference, and fuse metadata.

        Args:
            image_input: Image array or file path.
            tile_id: Optional tile stem identifier. If None, derived from filename.
            timestamp: Optional ISO 8601 timestamp string. If None, generated.
            model: Optional YOLO model overriding the instance model.
            synthetic_detections: Optional pre-computed or mocked detections for testing.

        Returns:
            Fused JSON document matching the exact schema contract.
        """
        # Determine tile_id
        if tile_id is None:
            if isinstance(image_input, (str, Path)):
                tile_id = Path(image_input).stem
            else:
                tile_id = f"tile_{uuid.uuid4().hex[:8]}"

        # Determine ISO 8601 timestamp
        if timestamp is None:
            timestamp = datetime.now(timezone.utc).isoformat()

        # Step 1: Run pure pixel-domain acoustic quality audit
        quality_report = self.auditor.audit(image_input)

        # Step 2: Acquire detections (synthetic or YOLO inference)
        active_model = model if model is not None else self.model
        if synthetic_detections is not None:
            raw_detections = synthetic_detections
        elif active_model is not None:
            raw_detections = self._extract_yolo_detections(active_model, image_input)
        else:
            raw_detections = []

        # Step 3: Calibrate detections in-stride (non-destructive)
        calibrated_detections = self._calibrate_detections(
            raw_detections,
            quality_report["status"],
        )

        # Step 4: Assemble fused JSON output
        return {
            "tile_id": tile_id,
            "timestamp": timestamp,
            "detections": calibrated_detections,
            "quality": quality_report,
        }
