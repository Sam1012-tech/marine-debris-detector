// Anomalous Reporting & Geotagging Engine
//
// Turns the in-memory detection list into a structured report — JSON or
// CSV — with exact location, bounding dimensions, and classification for
// every flagged hazard. This is client-side only: it reports on whatever
// detections are currently loaded (mock data for now). Once the backend
// exists, either keep this as-is (it works on real detections just as
// well) or move report generation server-side and point these buttons at
// a download endpoint instead.

import { classLabel, isCriticalClass, CONFIDENCE_AUTO_CONFIRM_THRESHOLD } from './taxonomy.js'

// HIGH always wins for a critical class (ordnance/safety) regardless of
// model confidence — mirrors the "needs-review no matter how confident"
// rule already applied in classifyConfidence().
function severityFor(d) {
  if (isCriticalClass(d.class)) return 'HIGH'
  if (d.confidence != null && d.confidence >= CONFIDENCE_AUTO_CONFIRM_THRESHOLD) return 'MEDIUM'
  return 'LOW'
}

function buildReport(survey, detections) {
  return {
    survey_id: survey?.id ?? null,
    vessel: survey?.vessel ?? null,
    area: survey?.area ?? null,
    generated_at: new Date().toISOString(),
    detection_count: detections.length,
    detections: detections.map((d) => ({
      id: d.id,
      line_id: d.lineId,
      site: d.site,
      class: classLabel(d.class),
      confidence: d.confidence,
      severity: severityFor(d),
      review_status: d.status,
      latitude: d.location?.lat ?? null,
      longitude: d.location?.lon ?? null,
      bounding_box: {
        width_m: d.boundingBoxM?.width ?? null,
        height_m: d.boundingBoxM?.height ?? null,
        area_m2: d.areaM2 ?? null,
      },
      acoustic_shadow_m: d.acousticShadowM,
      slant_range_m: d.slantRangeM,
      detected_at: d.timestamp,
    })),
  }
}

function toCsv(report) {
  const headers = [
    'id',
    'line_id',
    'site',
    'class',
    'confidence',
    'severity',
    'review_status',
    'latitude',
    'longitude',
    'width_m',
    'height_m',
    'area_m2',
    'acoustic_shadow_m',
    'slant_range_m',
    'detected_at',
  ]
  const rows = report.detections.map((d) => [
    d.id,
    d.line_id,
    d.site,
    d.class,
    d.confidence,
    d.severity,
    d.review_status,
    d.latitude ?? '',
    d.longitude ?? '',
    d.bounding_box.width_m,
    d.bounding_box.height_m,
    d.bounding_box.area_m2,
    d.acoustic_shadow_m,
    d.slant_range_m,
    d.detected_at,
  ])
  const escape = (v) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [headers, ...rows].map((row) => row.map(escape).join(',')).join('\n')
}

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function downloadReportJson(survey, detections) {
  const report = buildReport(survey, detections)
  download(`${report.survey_id || 'survey'}-detections.json`, JSON.stringify(report, null, 2), 'application/json')
}

export function downloadReportCsv(survey, detections) {
  const report = buildReport(survey, detections)
  download(`${report.survey_id || 'survey'}-detections.csv`, toCsv(report), 'text/csv')
}
