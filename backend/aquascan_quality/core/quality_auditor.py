"""Acoustic Data Quality Engine for Side-Scan Sonar Imagery.

Provides non-destructive, in-stride quality auditing over raster sonar swaths,
measuring acoustic saturation, ping dropout scanlines, and contrast dynamic range.
Isolated thresholding is enforced via an external YAML configuration schema.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Dict, List, Tuple, Union

import cv2
import numpy as np
import yaml


class AcousticQualityAuditor:
    """Pure pixel-domain acoustic metrics & scoring engine.

    Evaluates side-scan sonar image tiles for acoustic data anomalies without
    discarding or suppressing targets. Computes auditable flags, metrics, and quality
    scores backed by deterministic configuration hashing.
    """

    def __init__(self, config: Union[Dict[str, Any], str, Path, None] = None) -> None:
        """Initialize the auditor with an external configuration.

        Args:
            config: Configuration dictionary, path to YAML config file, or None
                    to load default config at ../config/quality_config.yaml.
        """
        self.config = self._load_config(config)
        self.config_hash = self._compute_config_hash(self.config)
        self._unpack_parameters()

    @staticmethod
    def _load_config(config_source: Union[Dict[str, Any], str, Path, None]) -> Dict[str, Any]:
        """Load configuration from a dictionary, file path, or default location."""
        if isinstance(config_source, dict):
            return config_source

        if config_source is None:
            # Default to ../config/quality_config.yaml relative to this module
            base_dir = Path(__file__).resolve().parent.parent
            config_path = base_dir / "config" / "quality_config.yaml"
        else:
            config_path = Path(config_source)

        if not config_path.is_file():
            raise FileNotFoundError(f"Quality configuration file not found at: {config_path}")

        with open(config_path, "r", encoding="utf-8") as f:
            loaded = yaml.safe_load(f)
            if not isinstance(loaded, dict):
                raise ValueError(f"Invalid YAML config at {config_path}; expected dictionary.")
            return loaded

    @staticmethod
    def _compute_config_hash(cfg: Dict[str, Any]) -> str:
        """Compute an MD5 hash of configuration values for audit traceability."""
        serialized = json.dumps(cfg, sort_keys=True, default=str)
        return hashlib.md5(serialized.encode("utf-8")).hexdigest()

    def _unpack_parameters(self) -> None:
        """Extract and validate all threshold and penalty parameters from config."""
        thresholds = self.config.get("thresholds", {})
        scoring = self.config.get("scoring", {})
        provenance = self.config.get("metadata_provenance", {})

        # Saturation thresholds
        sat_cfg = thresholds.get("saturation", {})
        self.sat_cutoff = float(sat_cfg.get("intensity_cutoff", 250))
        self.sat_max_ratio = float(sat_cfg.get("max_allowed_ratio", 0.08))
        self.sat_penalty_weight = float(sat_cfg.get("penalty_weight", 0.35))

        # Dropout thresholds
        dropout_cfg = thresholds.get("dropout", {})
        self.dropout_row_floor = float(dropout_cfg.get("row_intensity_floor", 5.0))
        self.dropout_max_rows = int(dropout_cfg.get("max_allowed_rows", 2))
        self.dropout_penalty_per_row = float(dropout_cfg.get("penalty_per_row", 0.08))
        self.dropout_max_cap = float(dropout_cfg.get("max_penalty_cap", 0.30))

        # Dynamic range thresholds
        dr_cfg = thresholds.get("dynamic_range", {})
        self.dr_p_high = float(dr_cfg.get("percentile_high", 95.0))
        self.dr_p_low = float(dr_cfg.get("percentile_low", 5.0))
        self.dr_min_spread = float(dr_cfg.get("min_required_spread", 30.0))
        self.dr_penalty_weight = float(dr_cfg.get("penalty_weight", 0.25))

        # Scoring thresholds
        self.baseline_score = float(scoring.get("baseline_score", 1.0))
        self.pass_threshold = float(scoring.get("pass_threshold", 0.75))
        self.warning_threshold = float(scoring.get("warning_threshold", 0.50))

        # Provenance
        self.data_source = str(provenance.get("data_source", "image"))

    def _ensure_grayscale(self, image_input: Union[np.ndarray, str, Path]) -> np.ndarray:
        """Convert input image into a 2D grayscale NumPy array with vectorized safety.

        Gracefully handles filepath strings, Path objects, and 2D/3D/4D NumPy arrays.
        """
        if isinstance(image_input, (str, Path)):
            img_path = Path(image_input)
            if not img_path.is_file():
                raise FileNotFoundError(f"Input image file does not exist: {img_path}")
            # Read via OpenCV (or fallback)
            img = cv2.imread(str(img_path), cv2.IMREAD_UNCHANGED)
            if img is None:
                raise ValueError(f"Failed to decode image from path: {img_path}")
        elif isinstance(image_input, np.ndarray):
            img = image_input
        else:
            raise TypeError(f"Unsupported image input type: {type(image_input)}")

        # Convert multidimensional arrays to 2D grayscale
        if img.ndim == 2:
            return img
        elif img.ndim == 3:
            channels = img.shape[2]
            if channels == 1:
                return img[:, :, 0]
            elif channels == 3:
                return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            elif channels == 4:
                return cv2.cvtColor(img, cv2.COLOR_BGRA2GRAY)
            else:
                raise ValueError(f"Unexpected number of channels: {channels}")
        else:
            raise ValueError(f"Image array must be 2D or 3D, got ndim={img.ndim}")

    def _check_saturation(self, image: np.ndarray) -> Tuple[float, float, List[str]]:
        """Acoustic Saturation & Specular Clipping Assessment.

        Acoustic physical context:
        Acoustic saturation and specular clipping occur when high receiver gains
        (e.g., over-amplified Time-Varied Gain (TVG) curves) or strongly reflective
        metallic boundaries (ship hulls, cargo containers, exposed granite bedrock)
        exceed the maximum dynamic range of the transducer hydrophone array. This
        drives sensor electronics into hard clipping (pixel saturation), flattening
        subtle acoustic backscatter gradations and destroying target edge morphology.

        Returns:
            Tuple of (saturation_ratio, penalty, flags)
        """
        total_pixels = image.size
        if total_pixels == 0:
            return 0.0, 0.0, []

        saturated_pixels = int(np.count_nonzero(image >= self.sat_cutoff))
        sat_ratio = float(saturated_pixels / total_pixels)

        flags: List[str] = []
        penalty = 0.0

        if sat_ratio > self.sat_max_ratio:
            flags.append(
                f"Acoustic Clipping / Saturation ({sat_ratio * 100:.1f}% > {self.sat_max_ratio * 100:.1f}%)"
            )
            # Scale penalty proportionally above the allowable ratio ceiling
            ratio_excess = (sat_ratio - self.sat_max_ratio) / self.sat_max_ratio
            penalty = min(self.sat_penalty_weight, self.sat_penalty_weight * ratio_excess)

        return sat_ratio, penalty, flags

    def _check_dropout(self, image: np.ndarray) -> Tuple[int, float, List[str]]:
        """Acoustic Dropout & Missing Ping Scanlines Assessment.

        Acoustic physical context:
        Acoustic dropouts manifest as persistent dark/zero horizontal raster lines
        across cross-track scanlines. Physical causes include propeller wash aeration,
        acoustic cavitation bubbles forming over the transducer face, vehicle motion
        (pitch/roll spikes) exceeding beam steering limits, or telemetry packet loss
        across serial/Ethernet umbilical lines. A dropped scanline creates a total
        sensor blind zone along that sonar ping.

        Returns:
            Tuple of (dropout_row_count, penalty, flags)
        """
        if image.shape[0] == 0:
            return 0, 0.0, []

        # Vectorized row-wise average acoustic intensity
        row_means = np.mean(image, axis=1)
        dropout_rows = int(np.count_nonzero(row_means <= self.dropout_row_floor))

        flags: List[str] = []
        penalty = 0.0

        if dropout_rows > self.dropout_max_rows:
            flags.append(f"Acoustic Dropout ({dropout_rows} missing ping rows detected)")
            penalty = min(self.dropout_max_cap, dropout_rows * self.dropout_penalty_per_row)

        return dropout_rows, penalty, flags

    def _check_dynamic_range(self, image: np.ndarray) -> Tuple[float, float, List[str]]:
        """Dynamic Range & Contrast Floor (Acoustic Washout) Assessment.

        Acoustic physical context:
        Acoustic washout occurs when sound waves reflect off homogeneous, low-impedance
        substrates such as fluid mud, silt basins, or deep unstratified sediments, or
        when receiver sensitivity is underexposed. The lack of acoustic backscatter
        variation compresses pixel distributions into a narrow histogram band,
        preventing discrimination between seabed bottom reverberation and genuine
        target acoustic highlights and shadow zones.

        Returns:
            Tuple of (dynamic_range_spread, penalty, flags)
        """
        if image.size == 0:
            return 0.0, self.dr_penalty_weight, ["Low Dynamic Range / Contrast (0.0 < 0.0)"]

        p_high, p_low = np.percentile(image, [self.dr_p_high, self.dr_p_low])
        dyn_range = float(p_high - p_low)

        flags: List[str] = []
        penalty = 0.0

        if dyn_range < self.dr_min_spread:
            flags.append(
                f"Low Dynamic Range / Contrast ({dyn_range:.1f} < {self.dr_min_spread:.1f})"
            )
            penalty = self.dr_penalty_weight

        return dyn_range, penalty, flags

    def audit_tile(self, image_input: Union[np.ndarray, str, Path]) -> Dict[str, Any]:
        """Alias for audit(...) for API integration compatibility."""
        return self.audit(image_input)

    def audit(self, image_input: Union[np.ndarray, str, Path]) -> Dict[str, Any]:
        """Perform non-destructive in-stride quality audit over a sonar image tile.

        Args:
            image_input: NumPy array (grayscale/color) or path to an image file.

        Returns:
            Dictionary matching the acoustic data quality schema contract.
        """
        gray = self._ensure_grayscale(image_input)

        # Execute vectorized physical checks
        sat_ratio, sat_penalty, sat_flags = self._check_saturation(gray)
        drop_rows, drop_penalty, drop_flags = self._check_dropout(gray)
        dyn_range, dr_penalty, dr_flags = self._check_dynamic_range(gray)

        all_flags = sat_flags + drop_flags + dr_flags
        total_penalty = sat_penalty + drop_penalty + dr_penalty

        raw_score = max(0.0, min(1.0, self.baseline_score - total_penalty))
        final_score = round(raw_score, 2)

        # Status determination:
        # PASS: score >= pass_threshold AND zero active flags
        # WARNING: score >= warning_threshold (with active flags)
        # DEGRADED: score < warning_threshold
        if final_score >= self.pass_threshold and len(all_flags) == 0:
            status = "PASS"
        elif final_score >= self.warning_threshold:
            status = "WARNING"
        else:
            status = "DEGRADED"

        return {
            "score": final_score,
            "status": status,
            "source": self.data_source,
            "flags": all_flags,
            "metrics": {
                "saturation_ratio": round(sat_ratio, 4),
                "dropout_row_count": drop_rows,
                "dynamic_range": round(dyn_range, 2),
            },
            "config_hash": self.config_hash,
        }
