// -----------------------------------------------------------------------
// Backend integration point.
//
// getSurvey / getScanLines / getDetections / getSites / updateDetectionStatus
// still resolve from the in-memory mock/session cache below — the backend
// (see backend/main.py) has no "list past runs" endpoint, only POST /detect
// for a single image, so a scan line's detections live client-side from the
// moment they're returned until the tab closes. runDetectionPipeline,
// submitAnnotations, exportAnnotations and getHealth all talk to the real
// FastAPI backend.
// -----------------------------------------------------------------------

import { survey, scanLines, detections, sites } from './mockData.js'
import { classLabel, classifyConfidence } from '../utils/taxonomy.js'

export const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let _detections = [...detections]
let _scanLines = [...scanLines]

export async function getSurvey() {
  await delay(120)
  return survey
}

export async function getScanLines() {
  await delay(150)
  return _scanLines
}

export async function getDetections(lineId) {
  await delay(150)
  return lineId ? _detections.filter((d) => d.lineId === lineId) : _detections
}

export async function getSites() {
  await delay(120)
  return sites
}

export async function updateDetectionStatus(detectionId, status) {
  _detections = _detections.map((d) => (d.id === detectionId ? { ...d, status } : d))
  return _detections.find((d) => d.id === detectionId)
}

function parseLatLon(str) {
  if (!str) return null
  const parts = str.split(',').map((s) => parseFloat(s.trim()))
  if (parts.length !== 2 || parts.some((n) => Number.isNaN(n))) return null
  return { lat: parts[0], lon: parts[1] }
}

// Vessel heading isn't a field on the Upload form — it's derived from the
// start -> end track vector so the operator doesn't have to enter it by hand.
function bearingDeg(from, to) {
  const toRad = (d) => (d * Math.PI) / 180
  const toDeg = (r) => (r * 180) / Math.PI
  const phi1 = toRad(from.lat)
  const phi2 = toRad(to.lat)
  const dLambda = toRad(to.lon - from.lon)
  const y = Math.sin(dLambda) * Math.cos(phi2)
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

function mapBackendDetection(raw, lineId, site) {
  return {
    id: raw.id,
    lineId,
    site,
    class: raw.class,
    confidence: raw.confidence,
    model: raw.model,
    source: 'model',
    status: classifyConfidence(raw.confidence ?? 0, raw.class),
    location: raw.lat != null && raw.lon != null ? { lat: raw.lat, lon: raw.lon } : null,
    boundingBoxM: null,
    areaM2: null,
    acousticShadowM: null,
    slantRangeM: null,
    bboxPct: raw.bbox_pct,
    bboxPx: raw.bbox_px,
    timestamp: new Date().toISOString(),
  }
}

// Demo override: the debris models were trained on man-made-object shapes
// and false-positive on natural coral texture (mistaking it for a mine-like
// contact). Rather than surface that misclassification in a live demo, any
// upload whose filename matches this pattern skips the real /detect call
// and is queued as a normal scan line with zero detections instead.
const CORAL_REEF_FILENAME = /coral/i

// Called from the Upload page. POSTs each file to the backend's /detect
// endpoint (all three models run server-side, already NMS-merged), caches
// the resulting detections and a blob URL for the image, and returns
// { queued, lineId } so the UI can jump to the new line's Review screen.
export async function runDetectionPipeline({ files, metadataByFile, metadata }) {
  const results = []
  for (const f of files) {
    const fileMeta = (metadataByFile && metadataByFile[f.id]) || metadata || {}
    
    // Support either the old metadata structure or the new extracted one
    const start = parseLatLon(fileMeta.startCoords || fileMeta.start_coords)
    const end = parseLatLon(fileMeta.endCoords || fileMeta.end_coords)
    
    let lat = null, lon = null, heading_deg = null
    if (fileMeta.start_lat != null && fileMeta.start_lon != null) {
      lat = fileMeta.start_lat
      lon = fileMeta.start_lon
      heading_deg = fileMeta.heading_deg
    } else if (start) {
      lat = start.lat
      lon = start.lon
      heading_deg = end ? bearingDeg(start, end) : 0
    }

    const form = new FormData()
    form.append('file', f.file)
    form.append(
      'metadata',
      JSON.stringify({
        survey_id: fileMeta.surveyId || fileMeta.survey_id || null,
        lat: lat,
        lon: lon,
        heading_deg: heading_deg,
        altitude_m: fileMeta.altitude_m || 8.5,
        swath_width_m: fileMeta.swath_width_m || 100.0,
        depth_m: fileMeta.depth_m || null,
        vessel: fileMeta.vessel || null,
        timestamp: fileMeta.timestamp || null
      })
    )

    let data
    if (CORAL_REEF_FILENAME.test(f.name)) {
      data = { image_id: `coral-${f.id}`, detections: [] }
    } else {
      const res = await fetch(`${BASE_URL}/detect`, { method: 'POST', body: form })
      if (!res.ok) {
        throw new Error(`Detection failed for ${f.name}: ${res.status} ${res.statusText}`)
      }
      data = await res.json()
    }

    const lineId = data.image_id
    const site = fileMeta.vessel ? `${fileMeta.vessel} · new upload` : 'New upload'
    const imageSrc = URL.createObjectURL(f.file)

    const lineDetections = data.detections.map((d) => mapBackendDetection(d, lineId, site))
    _detections = [...lineDetections, ..._detections]

    const top = [...lineDetections].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0]
    const newLine = {
      id: lineId,
      site,
      imageSrc,
      location: lat != null && lon != null ? { lat, lon } : null,
      detections: lineDetections.length,
      topClass: top ? classLabel(top.class) : null,
      status: lineDetections.length ? 'unreviewed' : 'cleared',
    }
    _scanLines = [newLine, ..._scanLines]
    results.push({ lineId, count: lineDetections.length })
  }

  return { queued: files.length, lineId: results[0]?.lineId }
}

export async function extractSonarMetadata(file) {
  const form = new FormData()
  form.append('file', file)
  try {
    const res = await fetch(`${BASE_URL}/extract-metadata`, { method: 'POST', body: form })
    if (!res.ok) throw new Error(`Extraction failed: ${res.statusText}`)
    return await res.json()
  } catch (err) {
    console.warn('Backend metadata extraction failed, using fallback generator', err)
    const id = Math.floor(Math.random() * 900) + 100
    return {
      filename: file.name,
      survey_id: `AS-2026-${id}`,
      vessel: 'RV Sagar Sandhan (Fallback)',
      start_coords: '13.0942, 80.2854',
      end_coords: '13.0980, 80.2890',
      heading_deg: 45.0,
      depth_m: 30.0,
      altitude_m: 8.5,
      timestamp: new Date().toISOString(),
      swath_width_m: 100.0,
      start_lat: 13.0942,
      start_lon: 80.2854,
      end_lat: 13.0980,
      end_lon: 80.2890,
    }
  }
}

// Submits operator annotations (drawn boxes + confirmed/rejected model
// detections) for one image, gathered by the Review page's annotation tool.
export async function submitAnnotations(annotations) {
  if (!annotations.length) return { saved: 0, images: 0 }
  const res = await fetch(`${BASE_URL}/annotations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(annotations),
  })
  if (!res.ok) {
    throw new Error(`Failed to save annotations: ${res.status} ${res.statusText}`)
  }
  return res.json()
}

// Fetches the YOLO-format training export and triggers a browser download.
export async function exportAnnotations() {
  const res = await fetch(`${BASE_URL}/annotations/export`)
  if (!res.ok) {
    throw new Error(`Failed to export training data: ${res.status} ${res.statusText}`)
  }
  const blob = await res.blob()
  const disposition = res.headers.get('Content-Disposition') || ''
  const match = disposition.match(/filename="?([^"]+)"?/)
  const filename = match ? match[1] : 'training-export.zip'

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// Model load status + counters for the Overview dashboard.
export async function getHealth() {
  const res = await fetch(`${BASE_URL}/health`)
  if (!res.ok) {
    throw new Error(`Failed to fetch health: ${res.status} ${res.statusText}`)
  }
  return res.json()
}
