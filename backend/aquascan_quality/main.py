#!/usr/bin/env python3
"""AquaScan CLI Runner: Non-Destructive Acoustic Data Quality Engine & Pipeline Integrator.

Usage examples:
  # Process single image with stdout JSON:
  python main.py --image path/to/sonar_tile.png

  # Process single image with YOLO model and save output JSON:
  python main.py --image path/to/sonar_tile.png --model path/to/yolo.pt --output output.json

  # Process entire directory of sonar tiles:
  python main.py --dir path/to/tiles/ --output-dir path/to/audited_jsons/
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import time
from typing import List

# Ensure parent directory is in sys.path so package imports work seamlessly
current_dir = Path(__file__).resolve().parent
parent_dir = current_dir.parent
if str(parent_dir) not in sys.path:
    sys.path.insert(0, str(parent_dir))
if str(current_dir) not in sys.path:
    sys.path.insert(0, str(current_dir))

try:
    from aquascan_quality.core.pipeline_integrator import PipelineIntegrator
    from aquascan_quality.core.quality_auditor import AcousticQualityAuditor
except ImportError:
    from core.pipeline_integrator import PipelineIntegrator
    from core.quality_auditor import AcousticQualityAuditor

VALID_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp"}


def parse_args() -> argparse.ArgumentParser:
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="Auditable Acoustic Data Quality Engine & Metadata Calibration Layer (AquaScan)",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )

    input_group = parser.add_mutually_exclusive_group(required=True)
    input_group.add_argument(
        "--image",
        "-i",
        type=str,
        help="Path to a single side-scan sonar image tile.",
    )
    input_group.add_argument(
        "--dir",
        "-d",
        type=str,
        help="Path to directory containing sonar image tiles to process.",
    )

    parser.add_argument(
        "--config",
        "-c",
        type=str,
        default=None,
        help="Path to external quality_config.yaml (defaults to config/quality_config.yaml).",
    )
    parser.add_argument(
        "--model",
        "-m",
        type=str,
        default=None,
        help="Path to YOLO model weights (.pt). If omitted, only quality audit is executed.",
    )
    parser.add_argument(
        "--output",
        "-o",
        type=str,
        default=None,
        help="Path to output JSON file (for single image) or output directory (for batch).",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default=None,
        help="Alias for --output when processing a directory.",
    )
    parser.add_argument(
        "--indent",
        type=int,
        default=2,
        help="JSON indentation level for formatted output.",
    )
    parser.add_argument(
        "--quiet",
        "-q",
        action="store_true",
        help="Suppress console progress messages and only output valid JSON.",
    )

    return parser


def process_single_image(
    integrator: PipelineIntegrator,
    image_path: Path,
    output_path: Path | None,
    indent: int,
    quiet: bool,
) -> dict:
    """Process a single image tile and return the fused JSON dict."""
    t0 = time.perf_counter()
    result = integrator.process_image(image_path)
    elapsed_ms = (time.perf_counter() - t0) * 1000.0

    json_str = json.dumps(result, indent=indent)

    if output_path is not None:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(json_str)
        if not quiet:
            sys.stderr.write(
                f"[AquaScan] Processed {image_path.name} in {elapsed_ms:.1f}ms -> Saved to {output_path}\n"
                f"           Status: {result['quality']['status']} | Score: {result['quality']['score']} | "
                f"Detections: {len(result['detections'])} | Flags: {len(result['quality']['flags'])}\n"
            )
    else:
        print(json_str)

    return result


def process_directory(
    integrator: PipelineIntegrator,
    dir_path: Path,
    output_dir: Path | None,
    indent: int,
    quiet: bool,
) -> List[dict]:
    """Process all sonar tiles in a directory."""
    image_files = sorted(
        [p for p in dir_path.iterdir() if p.is_file() and p.suffix.lower() in VALID_IMAGE_EXTENSIONS]
    )

    if not image_files:
        if not quiet:
            sys.stderr.write(f"[AquaScan] No valid images found in directory: {dir_path}\n")
        return []

    if output_dir is not None:
        output_dir.mkdir(parents=True, exist_ok=True)

    results = []
    if not quiet:
        sys.stderr.write(f"[AquaScan] Found {len(image_files)} sonar tiles in {dir_path}\n")

    t_start = time.perf_counter()
    for img_path in image_files:
        dest_file = (output_dir / f"{img_path.stem}.json") if output_dir else None
        res = process_single_image(integrator, img_path, dest_file, indent, quiet)
        results.append(res)

    total_time = (time.perf_counter() - t_start) * 1000.0
    avg_time = total_time / len(image_files)

    if not quiet:
        pass_count = sum(1 for r in results if r["quality"]["status"] == "PASS")
        warn_count = sum(1 for r in results if r["quality"]["status"] == "WARNING")
        deg_count = sum(1 for r in results if r["quality"]["status"] == "DEGRADED")
        sys.stderr.write(
            f"\n[AquaScan Audit Summary]\n"
            f"  Total Processed: {len(results)}\n"
            f"  PASS: {pass_count} | WARNING: {warn_count} | DEGRADED: {deg_count}\n"
            f"  Average Processing Latency: {avg_time:.2f} ms/tile\n"
        )

    # If no output directory specified, output combined JSON array to stdout
    if output_dir is None:
        print(json.dumps(results, indent=indent))

    return results


def main() -> int:
    """Main CLI entrypoint."""
    parser = parse_args()
    args = parser.parse_args()

    # Resolve config path
    config_path = Path(args.config) if args.config else None

    try:
        auditor = AcousticQualityAuditor(config=config_path)
        integrator = PipelineIntegrator(auditor=auditor, model=args.model)
    except Exception as e:
        sys.stderr.write(f"[AquaScan Error] Initialization failed: {e}\n")
        return 1

    if args.image:
        img_path = Path(args.image)
        if not img_path.is_file():
            sys.stderr.write(f"[AquaScan Error] File not found: {img_path}\n")
            return 1
        out_path = Path(args.output) if args.output else None
        process_single_image(integrator, img_path, out_path, args.indent, args.quiet)

    elif args.dir:
        dir_path = Path(args.dir)
        if not dir_path.is_dir():
            sys.stderr.write(f"[AquaScan Error] Directory not found: {dir_path}\n")
            return 1
        out_dir = Path(args.output_dir or args.output) if (args.output_dir or args.output) else None
        process_directory(integrator, dir_path, out_dir, args.indent, args.quiet)

    return 0


if __name__ == "__main__":
    sys.exit(main())
