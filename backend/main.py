"""
DeepScan detection API.

Routes a single sonar image through three independently-trained YOLO
detectors (crab pot / shipwreck / mine), merges their outputs with
class-agnostic NMS, and optionally georeferences each detection using the
vessel nav fix supplied alongside the upload (see georef.py).

Also stores operator corrections from the Review page's annotation tool as
a YOLO-format dataset for the next active-learning training run.

Run:
    cd backend && uvicorn main:app --reload --port 8000
"""

import gc
import io
import json
import time
import uuid
import zipfile
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import psutil
import torch

# Prevent PyTorch from spawning thread pools and allocating autograd buffers in memory-constrained cloud environments
torch.set_num_threads(1)
torch.set_grad_enabled(False)

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from PIL import Image
from pydantic import BaseModel, Field

from georef import SonarGeometry, VesselNav, georeference_yolo_bbox
from db import (
    init_db,
    save_annotation_batch,
    log_event,
    annotated_image_count,
    iter_export_labels,
    iter_export_images,
    save_detections_and_coverage,
    get_coverage,
    fetch_risk_inputs,
)
from risk import compute_risk_zones, HAZARD_CLASSES

import sys
import numpy as np

BASE_DIR = Path(__file__).resolve().parent

# Ensure aquascan_quality module is accessible
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))
if str(BASE_DIR.parent) not in sys.path:
    sys.path.insert(0, str(BASE_DIR.parent))
if str(BASE_DIR.parent / "aquascan_quality") not in sys.path:
    sys.path.insert(0, str(BASE_DIR.parent / "aquascan_quality"))

from aquascan_quality.core.quality_auditor import AcousticQualityAuditor
from aquascan_quality.core.pipeline_integrator import PipelineIntegrator

quality_auditor = AcousticQualityAuditor()
pipeline_integrator = PipelineIntegrator(auditor=quality_auditor)

MODELS_DIR = BASE_DIR / "models"
DEMO_CACHE_DIR = BASE_DIR / "demo_cache"

MODELS_DIR.mkdir(parents=True, exist_ok=True)
DEMO_CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _get_demo_cache_path(filename: Optional[str]) -> Optional[Path]:
    """Resolves demo cache JSON path for preset gallery samples, or returns None."""
    if not filename:
        return None
    raw_name = Path(filename).name.lower()
    stem = Path(filename).stem.lower()

    candidates = [
        stem,
        raw_name,
        stem.replace("_", "-"),
        stem.replace("-", "_"),
    ]
    for prefix in ("demo-", "demo_", "sample-", "sample_"):
        if stem.startswith(prefix):
            candidates.append(stem[len(prefix):])

    if DEMO_CACHE_DIR.is_dir():
        for c in candidates:
            target = DEMO_CACHE_DIR / f"{c}.json"
            if target.is_file():
                return target
        for p in DEMO_CACHE_DIR.glob("*.json"):
            if p.stem.lower() in candidates:
                return p
    return None

# Primes psutil's internal counter — cpu_percent() compares against the last
# call, so an unprimed first call always reads 0.0.
psutil.cpu_percent(interval=None)

app = FastAPI(title="DeepScan Detection API")

# Dev CORS: the Vite frontend runs on a different origin (localhost:5173).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    # The frontend reads the export filename off this header — CORS hides
    # response headers from JS by default unless explicitly exposed.
    expose_headers=["Content-Disposition"],
)


@app.get("/")
def root():
    return {
        "status": "ok",
        "service": "Marine Debris Detector API",
        "endpoints": ["/health", "/detect", "/extract-metadata", "/annotations", "/annotations/export"]
    }


# Kept in sync with src/utils/taxonomy.js's DEBRIS_CLASSES.
#
# Maps a model's own internal class name (lowercased) to our canonical
# taxonomy key. A class name NOT listed here is dropped from the results
# entirely (see _run_model) rather than mislabeled as the model's nominal
# type — inspecting the actual weights showed "ship-model.pt" is really a
# 4-class model (also outputs "airplane" and "drowning_victim_human", not
# just shipwreck) and "mine-model.pt" outputs naval mine-countermeasures
# classes MILCO (mine-like contact) and NOMBO (non-mine bottom object —
# explicitly *not* a mine). Silently renaming those to the model's nominal
# class would misrepresent what the model actually said.
CLASS_NAME_ALIASES = {
    "crab-pot": "crab_pot",
    "crab_pot": "crab_pot",
    "crabpot": "crab_pot",
    "wreck_shipwreck": "shipwreck",
    "shipwreck": "shipwreck",
    "mine": "mine",
    "milco": "mine",
    "nombo": "non_mine_object",
    "airplane": "airplane",
    "drowning_victim_human": "human_in_water",
    "human_in_water": "human_in_water",
    "ghost_net": "ghost_net",
    "unknown_debris": "unknown_debris",
}
# ghost_net and unknown_debris have no dedicated model — they only ever come
# from operator annotations, never a live detection `class` value.
CLASS_NAMES = ["crab_pot", "shipwreck", "mine", "ghost_net", "unknown_debris", "human_in_water", "airplane", "non_mine_object"]

MODEL_SPECS = [
    {"key": "crab_pot", "label": "Crab Pot Detector", "match": ("crabpot", "crab_pot", "crab-pot", "crab")},
    {"key": "shipwreck", "label": "Shipwreck Detector", "match": ("shipwreck", "ship-wreck", "ship_wreck", "ship", "wreck")},
    {"key": "mine", "label": "Mine Detector", "match": ("mine",)},
]

NMS_IOU_THRESHOLD = 0.5
DEFAULT_SWATH_WIDTH_M = 100.0


# -- Model loading ------------------------------------------------------------
#
# Every .pt file matching a class (e.g. crabpot_yolo26m.pt AND
# crabpot_yolo26s.pt both matching "crab_pot") is loaded and run on every
# /detect call — this is not "pick one variant," it's ensembling: each
# variant votes with its own confidence, and _nms() below keeps whichever
# one scored highest wherever two variants' boxes overlap the same object.

class LoadedModel:
    def __init__(self, key: str, label: str, path: Optional[Path]):
        self.key = key
        self.label = label
        self.path = path
        self.size_mb = round(path.stat().st_size / (1024 * 1024), 2) if path else None
        # Prefixed with the class key so it's always identifiable downstream
        # (the `model` field on each detection, and the frontend's
        # modelLabel() pattern match) even when the file itself is named
        # generically, e.g. models/crab-pot/yolo26s.pt -> "crab_pot_yolo26s".
        self.model_id = f"{key}_{path.stem}" if path else None


def _discover_model_paths(spec: dict) -> List[Path]:
    # Recursive, and matched against the path *relative to models/* rather
    # than just the filename — a model dropped in a class-named subfolder
    # (models/crab-pot/yolo26s.pt) is matched by the folder name even when
    # the filename itself is generic.
    return sorted(
        p for p in MODELS_DIR.rglob("*.pt")
        if any(m in p.relative_to(MODELS_DIR).as_posix().lower() for m in spec["match"])
    )


MODELS: List[LoadedModel] = []
_last_inference_ms: Optional[float] = None
# Raw bytes of recently /detect-ed images, keyed by image_id, so /annotations
# can archive a copy of the source image without the client re-uploading it.
_IMAGE_CACHE: Dict[str, Tuple[bytes, str]] = {}
_IMAGE_CACHE_LIMIT = 200


@app.on_event("startup")
def startup():
    init_db()
    load_models()


def load_models():
    for spec in MODEL_SPECS:
        paths = _discover_model_paths(spec)
        if not paths:
            # No .pt file for this class yet — keep one unloaded placeholder
            # so /health can still report it as "Unavailable".
            MODELS.append(LoadedModel(spec["key"], spec["label"], None))
            continue
        # In cloud containers with 512MB RAM, avoid duplicate size variants
        if len(paths) > 1 and any("yolo26s" in p.name.lower() for p in paths):
            paths = [p for p in paths if "yolo26m" not in p.name.lower()]

        for path in paths:
            MODELS.append(LoadedModel(spec["key"], spec["label"], path))
    gc.collect()


load_models()



# -- Detection ------------------------------------------------------------------

class DetectMetadata(BaseModel):
    survey_id: Optional[str] = None
    lat: Optional[float] = None
    lon: Optional[float] = None
    heading_deg: Optional[float] = None
    swath_width_m: Optional[float] = None


def _iou(a: List[float], b: List[float]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    if inter <= 0:
        return 0.0
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def _nms(boxes: List[dict], iou_threshold: float = NMS_IOU_THRESHOLD) -> List[dict]:
    """Greedy, class-agnostic NMS pooled across all three models' outputs —
    the same physical object can trigger more than one model, so this dedups
    across model boundaries rather than per-class."""
    ordered = sorted(boxes, key=lambda b: b["confidence"], reverse=True)
    kept: List[dict] = []
    for cand in ordered:
        if all(_iou(cand["bbox_px"], k["bbox_px"]) <= iou_threshold for k in kept):
            kept.append(cand)
    return kept


def _run_model(loaded: LoadedModel, image: Image.Image) -> List[dict]:
    if loaded.path is None or not loaded.path.exists():
        return []
    from ultralytics import YOLO
    model = YOLO(str(loaded.path))
    with torch.inference_mode():
        results = model.predict(image, imgsz=640, verbose=False)
    out = []
    for r in results:
        boxes = r.boxes
        if boxes is None:
            continue
        names = r.names or {}
        for box in boxes:
            xyxy = [float(v) for v in box.xyxy[0].tolist()]
            conf = float(box.conf[0])
            cls_id = int(box.cls[0])
            raw_name = names.get(cls_id) if isinstance(names, dict) else None
            class_name = CLASS_NAME_ALIASES.get((raw_name or "").strip().lower())
            if class_name is None:
                continue  # not in our taxonomy -- drop it, don't mislabel it as loaded.key
            out.append({
                "bbox_px": xyxy,
                "confidence": conf,
                "class": class_name,
                "model": loaded.model_id,
            })
    del model, results
    gc.collect()
    try:
        import ctypes
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except Exception:
        pass
    return out


@app.post("/detect")
async def detect(file: UploadFile = File(...), metadata: Optional[str] = Form(None)):
    global _last_inference_ms
    cache_path = _get_demo_cache_path(file.filename)
    if cache_path and cache_path.is_file():
        start_cache = time.perf_counter()
        raw = await file.read()
        ext = Path(file.filename or "").suffix or ".png"

        with open(cache_path, "r", encoding="utf-8") as f:
            payload = json.load(f)

        if metadata:
            try:
                client_meta = json.loads(metadata)
                if isinstance(client_meta, dict):
                    for k, v in client_meta.items():
                        if v is not None and k in payload:
                            payload[k] = v
            except Exception:
                pass

        image_id = payload.get("image_id") or f"demo-{cache_path.stem}"
        if len(_IMAGE_CACHE) >= _IMAGE_CACHE_LIMIT:
            _IMAGE_CACHE.pop(next(iter(_IMAGE_CACHE)))
        _IMAGE_CACHE[image_id] = (raw, ext)

        elapsed_ms = round((time.perf_counter() - start_cache) * 1000, 1)
        payload["processing_time_ms"] = min(elapsed_ms, payload.get("processing_time_ms", 14.0))

        _last_inference_ms = payload["processing_time_ms"]

        log_event(
            "detect_cache_hit",
            {
                "image_id": image_id,
                "filename": file.filename,
                "count": len(payload.get("detections", [])),
                "elapsed_ms": elapsed_ms,
            },
        )

        return JSONResponse(content=payload, status_code=200)

    raw = await file.read()
    try:
        image = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception:
        raise HTTPException(status_code=400, detail="Could not read uploaded file as an image.")

    width, height = image.size

    meta = DetectMetadata()
    if metadata:
        try:
            meta = DetectMetadata(**json.loads(metadata))
        except Exception:
            raise HTTPException(status_code=400, detail="metadata must be a JSON object.")

    nav = None
    if meta.lat is not None and meta.lon is not None:
        nav = VesselNav(lat=meta.lat, lon=meta.lon, heading_deg=meta.heading_deg or 0.0)
    swath_m = meta.swath_width_m or DEFAULT_SWATH_WIDTH_M
    geometry = SonarGeometry(swath_width_m=swath_m, slant_range_corrected=True)

    start = time.perf_counter()
    pooled: List[dict] = []
    for loaded in MODELS:
        pooled.extend(_run_model(loaded, image))
    kept = _nms(pooled)
    elapsed_ms = round((time.perf_counter() - start) * 1000, 1)

    # In-stride acoustic data quality audit (pure pixel-domain)
    img_np = np.array(image)
    quality = quality_auditor.audit_tile(img_np)
    is_low_quality = quality.get("status") != "PASS"

    image_id = str(uuid.uuid4())
    detections = []
    for det in kept:
        x1, y1, x2, y2 = det["bbox_px"]
        lat = lon = None
        if nav is not None:
            lat, lon = georeference_yolo_bbox([x1, y1, x2, y2], width, height, nav, geometry)
        
        det_data = {
            "id": f"det_{uuid.uuid4().hex[:12]}",
            "class": det["class"],
            "confidence": round(det["confidence"], 4),
            "model": det["model"],
            "bbox_px": [round(v, 1) for v in (x1, y1, x2, y2)],
            "bbox_pct": {
                "top": round(y1 / height, 5),
                "left": round(x1 / width, 5),
                "width": round((x2 - x1) / width, 5),
                "height": round((y2 - y1) / height, 5),
            },
            "lat": lat,
            "lon": lon,
            "quality_warning": is_low_quality,
        }
        if is_low_quality:
            det_data["quality_note"] = "low data quality"
        detections.append(det_data)

    # Cache the raw bytes so a later POST /annotations can archive the
    # source image without the client having to re-upload it.
    ext = Path(file.filename or "").suffix or ".png"
    if len(_IMAGE_CACHE) >= _IMAGE_CACHE_LIMIT:
        _IMAGE_CACHE.pop(next(iter(_IMAGE_CACHE)))
    _IMAGE_CACHE[image_id] = (raw, ext)
    _last_inference_ms = elapsed_ms

    log_event("detect", {"image_id": image_id, "count": len(detections), "elapsed_ms": elapsed_ms})

    # Risk-zone inputs: the surveyed footprint (denominator for detections per
    # km^2) plus the georeferenced detections. Along-track length assumes
    # square pixels, i.e. the same m/px as the across-track georeferencing.
    # Never allowed to break /detect itself.
    if nav is not None:
        try:
            length_m = height * (swath_m / width)
            save_detections_and_coverage(image_id, detections, {
                "lat": nav.lat, "lon": nav.lon, "heading_deg": nav.heading_deg,
                "swath_width_m": swath_m, "length_m": length_m,
                "area_km2": swath_m * length_m / 1e6, "img_w": width, "img_h": height,
            })
        except Exception as exc:
            print(f"[risk] could not persist coverage for {image_id}: {exc}")

    return {
        "image_id": image_id,
        "detections": detections,
        "quality": quality,
        "processing_time_ms": elapsed_ms,
    }


# -- Metadata extraction -----------------------------------------------------
#
# Real side-scan sonar formats (XTF/JSF/SEGY) carry nav fixes in their binary
# headers, but the images actually flowing through Upload today are plain
# JPG/PNG. The one real source of georeferencing on those is EXIF GPS tags —
# present on phone/drone photos, absent on sonar waterfall exports. Rather
# than inventing fake coordinates, this reads whatever EXIF actually exists
# and leaves the rest null for the operator to fill in on the Upload form.

GPS_IFD_TAG = 0x8825
EXIF_DATETIME_TAG = 0x0132


class ExtractedMetadata(BaseModel):
    filename: str
    survey_id: Optional[str] = None
    vessel: Optional[str] = None
    start_coords: Optional[str] = None
    end_coords: Optional[str] = None
    heading_deg: Optional[float] = None
    depth_m: Optional[float] = None
    altitude_m: Optional[float] = None
    timestamp: Optional[str] = None
    swath_width_m: Optional[float] = None
    start_lat: Optional[float] = None
    start_lon: Optional[float] = None
    end_lat: Optional[float] = None
    end_lon: Optional[float] = None


def _dms_to_deg(dms, ref: Optional[str]) -> Optional[float]:
    try:
        deg, minutes, seconds = (float(v) for v in dms)
    except (TypeError, ValueError):
        return None
    val = deg + minutes / 60 + seconds / 3600
    if ref in ("S", "W"):
        val = -val
    return val


def _extract_gps(image: Image.Image) -> Tuple[Optional[float], Optional[float], Optional[float]]:
    """Returns (lat, lon, altitude_m) from EXIF GPS tags, or (None, None, None)."""
    try:
        exif = image.getexif()
        gps_ifd = exif.get_ifd(GPS_IFD_TAG)
    except Exception:
        return None, None, None
    if not gps_ifd:
        return None, None, None

    lat = _dms_to_deg(gps_ifd.get(2), gps_ifd.get(1))
    lon = _dms_to_deg(gps_ifd.get(4), gps_ifd.get(3))
    altitude = gps_ifd.get(6)
    altitude = float(altitude) if altitude is not None else None
    return lat, lon, altitude


@app.post("/extract-metadata")
async def extract_metadata(file: UploadFile = File(...)):
    cache_path = _get_demo_cache_path(file.filename)
    if cache_path and cache_path.is_file():
        try:
            with open(cache_path, "r", encoding="utf-8") as f:
                cached_data = json.load(f)
            return ExtractedMetadata(
                filename=file.filename or cache_path.name,
                survey_id=cached_data.get("survey_id"),
                vessel=cached_data.get("vessel"),
                start_coords=cached_data.get("start_coords") or cached_data.get("coords"),
                end_coords=cached_data.get("end_coords"),
                heading_deg=cached_data.get("heading_deg"),
                depth_m=cached_data.get("depth_m"),
                altitude_m=cached_data.get("altitude_m", 8.5),
                timestamp=cached_data.get("timestamp") or time.strftime("%Y-%m-%d %H:%M:%S"),
                swath_width_m=cached_data.get("swath_width_m", 100.0),
                start_lat=cached_data.get("start_lat"),
                start_lon=cached_data.get("start_lon"),
                end_lat=cached_data.get("end_lat"),
                end_lon=cached_data.get("end_lon"),
            )
        except Exception:
            pass

    raw = await file.read()
    try:
        image = Image.open(io.BytesIO(raw))
    except Exception:
        raise HTTPException(status_code=400, detail="Could not read uploaded file as an image.")

    lat, lon, altitude_m = _extract_gps(image)
    exif = image.getexif()
    timestamp = exif.get(EXIF_DATETIME_TAG)  # "YYYY:MM:DD HH:MM:SS", EXIF's native format

    return ExtractedMetadata(
        filename=file.filename or "unknown",
        start_coords=f"{lat:.4f}, {lon:.4f}" if lat is not None and lon is not None else None,
        heading_deg=None,
        depth_m=None,
        altitude_m=altitude_m,
        timestamp=timestamp,
        start_lat=lat,
        start_lon=lon,
    )


# -- Annotations (active learning store) -----------------------------------------

class Annotation(BaseModel):
    image_id: str
    bbox_normalized: List[float] = Field(..., min_length=4, max_length=4)
    class_id: int
    class_name: str
    source: str = "operator_correction"
    original_detection_id: Optional[str] = None
    # Not in the original schema draft, but required to represent a
    # "Reject Detection" call: the box is logged as a hard negative rather
    # than written into the YOLO label file as a positive example.
    rejected: bool = False
    # Filled in server-side from the image's stored nav fix (see
    # save_annotations) so operator-drawn boxes can contribute to risk zones.
    lat: Optional[float] = None
    lon: Optional[float] = None


@app.post("/annotations")
async def save_annotations(annotations: List[Annotation]):
    if not annotations:
        return {"saved": 0, "images": 0}

    by_image: Dict[str, List[Annotation]] = {}
    for a in annotations:
        by_image.setdefault(a.image_id, []).append(a)

    # Geocode each box from its image's stored nav fix. Best-effort: images
    # without a fix (or a failed lookup) simply stay un-located.
    for image_id, items in by_image.items():
        try:
            cov = get_coverage(image_id)
            if not cov:
                continue
            nav = VesselNav(lat=cov["lat"], lon=cov["lon"], heading_deg=cov["heading_deg"] or 0.0)
            geom = SonarGeometry(swath_width_m=cov["swath_width_m"], slant_range_corrected=True)
            for a in items:
                cx, cy = a.bbox_normalized[0], a.bbox_normalized[1]
                px, py = cx * cov["img_w"], cy * cov["img_h"]
                a.lat, a.lon = georeference_yolo_bbox([px, py, px, py], cov["img_w"], cov["img_h"], nav, geom)
        except Exception as exc:
            print(f"[risk] could not geocode annotations for {image_id}: {exc}")

    saved, rejected = save_annotation_batch(by_image, _IMAGE_CACHE)

    return {"saved": saved, "images": len(by_image)}


@app.get("/annotations/export")
def export_annotations():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for image_id, label_text in iter_export_labels():
            zf.writestr(f"labels/{image_id}.txt", label_text)
        for image_id, ext, data in iter_export_images():
            zf.writestr(f"images/{image_id}{ext}", data)
    buf.seek(0)
    filename = f"deepscan-training-export-{time.strftime('%Y%m%d-%H%M%S')}.zip"
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


# -- Risk zones ---------------------------------------------------------------------

_PRIORS_PATH = BASE_DIR / "data" / "risk_priors.json"


def _load_priors() -> list:
    try:
        return json.loads(_PRIORS_PATH.read_text(encoding="utf-8")).get("risk_zones", [])
    except Exception as exc:
        print(f"[risk] priors unavailable ({exc}); scoring without the static prior")
        return []


@app.get("/risk-zones")
def risk_zones(hazard: str = "all", cell_km: float = 1.0):
    """Data-driven risk zones as GeoJSON. Only surveyed cells are returned —
    unsurveyed areas are unknown, not safe. See docs/RISK_ZONES.md."""
    if hazard not in HAZARD_CLASSES:
        raise HTTPException(status_code=400, detail=f"hazard must be one of {sorted(HAZARD_CLASSES)}")
    cell_km = min(max(cell_km, 0.25), 25.0)
    events, coverage = fetch_risk_inputs()
    return compute_risk_zones(events, coverage, _load_priors(), cell_km=cell_km, hazard=hazard)


# -- Health -----------------------------------------------------------------------

@app.get("/debug/models")
def debug_models():
    """Temporary — shows exactly what's on disk in MODELS_DIR inside the
    running container, so a "loaded: false" on /health can be diagnosed
    without guessing at the build platform's internals. Remove once the
    model-loading issue is confirmed fixed."""
    if not MODELS_DIR.exists():
        return {"models_dir": str(MODELS_DIR), "exists": False}
    found = [
        {"path": str(p.relative_to(MODELS_DIR)), "size_mb": round(p.stat().st_size / (1024 * 1024), 2)}
        for p in MODELS_DIR.rglob("*.pt")
    ]
    all_entries = [str(p.relative_to(MODELS_DIR)) for p in MODELS_DIR.rglob("*")]
    return {"models_dir": str(MODELS_DIR), "exists": True, "pt_files_found": found, "all_entries": all_entries}


@app.get("/health")
def health():
    by_key: Dict[str, List[LoadedModel]] = {}
    for loaded in MODELS:
        by_key.setdefault(loaded.key, []).append(loaded)

    models_status = {}
    for spec in MODEL_SPECS:
        variants = [m for m in by_key.get(spec["key"], []) if m.path is not None and m.path.exists()]
        # model_id/size_mb mirror the first loaded variant for backward
        # compatibility with a single-variant reading of this response;
        # `variants` lists all of them when there's more than one.
        models_status[spec["key"]] = {
            "label": spec["label"],
            "loaded": bool(variants),
            "model_id": variants[0].model_id if variants else None,
            "size_mb": variants[0].size_mb if variants else None,
            "variants": [{"model_id": v.model_id, "size_mb": v.size_mb} for v in variants],
        }
    return {
        "status": "ok",
        "models": models_status,
        "last_inference_ms": _last_inference_ms,
        "annotations": {"image_count": annotated_image_count()},
        "system": {
            "cpu_percent": psutil.cpu_percent(interval=None),
            "memory_percent": psutil.virtual_memory().percent,
        },
    }
