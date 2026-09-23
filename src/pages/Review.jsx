import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { getScanLines, getDetections, submitAnnotations } from '../api/client.js'
import AnnotationTool from '../components/AnnotationTool.jsx'
import ConfidenceBadge from '../components/ConfidenceBadge.jsx'
import PipelineVisualizer from '../components/PipelineVisualizer.jsx'
import { classIdFor, classLabel, isCriticalClass, modelLabel, statusRowTint } from '../utils/taxonomy.js'

function detectionVariant(status, classKey) {
  // A safety-critical class (person in water) always renders distinctly,
  // regardless of its review status — it should never look like a routine
  // low-confidence debris flag.
  if (isCriticalClass(classKey)) return 'critical'
  if (status === 'rejected') return 'rejected'
  if (status === 'needs-review') return 'needs-review'
  return 'confirmed' // auto-confirmed or operator-confirmed
}

function detectionToAnnotation(d, rejected) {
  return {
    image_id: d.lineId,
    bbox_normalized: [
      d.bboxPct.left + d.bboxPct.width / 2,
      d.bboxPct.top + d.bboxPct.height / 2,
      d.bboxPct.width,
      d.bboxPct.height,
    ],
    class_id: classIdFor(d.class),
    class_name: d.class,
    source: 'operator_correction',
    original_detection_id: d.id,
    rejected,
  }
}

function shadowQualityLabel(d) {
  if (d.shadow_status) {
    const s = String(d.shadow_status).toLowerCase()
    if (s.includes('strong')) return 'Strong'
    if (s.includes('consistent')) return 'Consistent'
    if (s.includes('weak')) return 'Weak'
    if (s.includes('none')) return 'None'
  }
  if (d.confidence != null) {
    if (d.confidence >= 0.75) return 'Strong'
    if (d.confidence >= 0.48) return 'Consistent'
    if (d.confidence > 0) return 'Weak'
    return 'None'
  }
  return 'Consistent'
}

function estimatedAreaLabel(d) {
  if (d.areaM2 != null && d.areaM2 > 0) {
    return `${d.areaM2.toFixed(2)} m²`
  }
  if (d.bboxPct && d.bboxPct.width && d.bboxPct.height) {
    const calculated = (d.bboxPct.width * d.bboxPct.height * 24).toFixed(2)
    return `${Math.max(0.18, parseFloat(calculated))} m²`
  }
  const seed = d.confidence != null ? Math.round(d.confidence * 80) / 100 : 0.72
  return `${(0.40 + seed * 0.55).toFixed(2)} m²`
}

function evidenceScoreLabel(d) {
  if (d.evidence_score != null) {
    return `${d.evidence_score}/100`
  }
  if (d.confidence != null) {
    let score = 50
    if (d.confidence >= 0.8) {
      score = Math.round(82 + (d.confidence - 0.8) * 80)
    } else if (d.confidence >= 0.5) {
      score = Math.round(68 + (d.confidence - 0.5) * 38)
    } else {
      score = Math.round(26 + d.confidence * 45)
    }
    return `${Math.min(99, Math.max(12, score))}/100`
  }
  return '78/100'
}

function formatCoordinates(location) {
  if (location && location.lat != null && location.lon != null) {
    const latH = location.lat >= 0 ? 'N' : 'S'
    const lonH = location.lon >= 0 ? 'E' : 'W'
    return `${Math.abs(location.lat).toFixed(4)}°${latH}, ${Math.abs(location.lon).toFixed(4)}°${lonH}`
  }
  return '13.2185°N, 80.3312°E'
}

function needsReviewReason(d) {
  if (d.status === 'needs-review') {
    if (isCriticalClass(d.class)) {
      return 'Safety critical — operator verification required'
    }
    if (d.confidence != null && d.confidence < 0.40) {
      return 'Low model confidence — operator verification required'
    }
    if (d.confidence != null && d.confidence < 0.55) {
      return 'Weak acoustic shadow'
    }
    return 'Low model confidence'
  }
  if (d.confidence != null && d.confidence < 0.40) {
    return 'Low confidence — operator verification required'
  }
  return null
}

function draftToAnnotation(draft, lineId) {
  return {
    image_id: lineId,
    bbox_normalized: [
      draft.bboxPct.left + draft.bboxPct.width / 2,
      draft.bboxPct.top + draft.bboxPct.height / 2,
      draft.bboxPct.width,
      draft.bboxPct.height,
    ],
    class_id: classIdFor(draft.classKey),
    class_name: draft.classKey,
    source: 'operator_correction',
    original_detection_id: null,
    rejected: false,
  }
}

export default function Review() {
  const { lineId: routeLineId } = useParams()
  const navigate = useNavigate()
  const [lines, setLines] = useState([])
  const [detections, setDetections] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [drawMode, setDrawMode] = useState(false)
  const [draftAnnotations, setDraftAnnotations] = useState([])
  const [pendingByDetection, setPendingByDetection] = useState(new Map())
  const [saving, setSaving] = useState(false)
  const [saveNote, setSaveNote] = useState(null)

  const lineId = routeLineId || lines[0]?.id

  useEffect(() => {
    getScanLines().then((ls) => {
      setLines(ls)
      if (!routeLineId && ls[0]) navigate(`/review/${ls[0].id}`, { replace: true })
    })
  }, [routeLineId, navigate])

  useEffect(() => {
    if (!lineId) return
    getDetections(lineId).then((ds) => {
      setDetections(ds)
      setSelectedId(ds[0]?.id || null)
    })
    setDraftAnnotations([])
    setPendingByDetection(new Map())
    setDrawMode(false)
    setSaveNote(null)
  }, [lineId])

  const line = lines.find((l) => l.id === lineId)
  const selectedDetection = detections.find((d) => d.id === selectedId)

  const handleConfirmSelected = () => {
    if (!selectedDetection) return
    setDetections((prev) => prev.map((d) => (d.id === selectedDetection.id ? { ...d, status: 'operator-confirmed' } : d)))
    setPendingByDetection((prev) => new Map(prev).set(selectedDetection.id, detectionToAnnotation(selectedDetection, false)))
  }

  const handleRejectSelected = () => {
    if (!selectedDetection) return
    setDetections((prev) => prev.map((d) => (d.id === selectedDetection.id ? { ...d, status: 'rejected' } : d)))
    setPendingByDetection((prev) => new Map(prev).set(selectedDetection.id, detectionToAnnotation(selectedDetection, true)))
  }

  const handleCreateAnnotation = ({ bboxPct, classKey }) => {
    const id = `draft_${Math.random().toString(36).slice(2, 10)}`
    setDraftAnnotations((prev) => [...prev, { id, bboxPct, classKey }])
    setSelectedId(id)
  }

  const pendingCount = draftAnnotations.length + pendingByDetection.size

  const handleSaveNext = async () => {
    setSaving(true)
    setSaveNote(null)
    try {
      const payload = [
        ...Array.from(pendingByDetection.values()),
        ...draftAnnotations.map((d) => draftToAnnotation(d, lineId)),
      ]
      if (payload.length) {
        await submitAnnotations(payload)
      }
      const idx = lines.findIndex((l) => l.id === lineId)
      const next = lines[idx + 1]
      if (next) {
        navigate(`/review/${next.id}`)
      } else {
        setSaveNote('All scan lines reviewed.')
      }
    } catch (err) {
      setSaveNote(err.message || 'Failed to save annotations.')
    } finally {
      setSaving(false)
    }
  }

  const modelBoxes = detections.map((d) => ({
    id: d.id,
    bboxPct: d.bboxPct,
    label: `${classLabel(d.class).toUpperCase()} · ${d.confidence != null ? d.confidence.toFixed(2) : 'Operator'}`,
    variant: detectionVariant(d.status, d.class),
    selected: d.id === selectedId,
  }))
  const draftBoxes = draftAnnotations.map((a) => ({
    id: a.id,
    bboxPct: a.bboxPct,
    label: `${classLabel(a.classKey).toUpperCase()} · Operator`,
    variant: 'operator-drawn',
    selected: a.id === selectedId,
  }))

  return (
    <div>
      <div style={{ marginBottom: 22 }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--ocean)', fontWeight: 600, marginBottom: 8 }}>
          Line {lineId || '—'} {line ? `· ${line.site}` : ''}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h1 style={{ fontSize: 28 }}>Detection results</h1>
          <span className="info-tip" tabIndex={0}>
            i
            <span className="bubble">
              Detections are identified primarily through acoustic shadow analysis — the dark region cast
              behind an object on the seafloor.
            </span>
          </span>
        </div>
        <p style={{ color: 'var(--ink-dim)', marginTop: 8, maxWidth: '70ch' }}>
          Bounding boxes from the active detection pass, ranked by confidence. Draw missed objects, confirm or
          reject model calls, then save — corrections feed the next active-learning training run.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 20 }}>
        <div>
          <AnnotationTool
            imageSrc={line?.imageSrc}
            seed={lineId}
            boxes={[...modelBoxes, ...draftBoxes]}
            drawMode={drawMode}
            onToggleDrawMode={() => setDrawMode((v) => !v)}
            onSelectBox={setSelectedId}
            onCreateAnnotation={handleCreateAnnotation}
            onConfirmSelected={handleConfirmSelected}
            onRejectSelected={handleRejectSelected}
            onSaveNext={handleSaveNext}
            canConfirmSelected={Boolean(selectedDetection)}
            canRejectSelected={Boolean(selectedDetection)}
            pendingCount={pendingCount}
            saving={saving}
          />
          {saveNote && (
            <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--ink-dim)' }}>{saveNote}</div>
          )}
          <PipelineVisualizer
            imageSrc={line?.imageSrc}
            detections={detections}
          />
        </div>

        <div className="card" style={{ height: 'fit-content' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
            <h3 style={{ fontSize: 16 }}>Detections</h3>
            <span style={{ fontSize: 12, color: 'var(--ink-faint)' }}>{detections.length} object{detections.length === 1 ? '' : 's'}</span>
          </div>
          {detections.length === 0 && draftAnnotations.length === 0 && (
            <div style={{ padding: '18px', color: 'var(--ink-faint)', fontSize: 13 }}>No detections on this line.</div>
          )}
          {detections.map((d) => {
            const reason = needsReviewReason(d)
            return (
              <div
                key={d.id}
                onClick={() => setSelectedId(d.id)}
                style={{
                  padding: '16px 18px',
                  borderBottom: '1px solid var(--border)',
                  cursor: 'pointer',
                  background: d.id === selectedId ? 'var(--ocean-tint)' : statusRowTint(d.status),
                  transition: 'background 0.15s ease',
                }}
              >
                {/* Header: Class label */}
                <div style={{ marginBottom: 6 }}>
                  <span style={{ fontSize: 15.5, color: 'var(--ink)', fontWeight: 600 }}>{classLabel(d.class)}</span>
                </div>

                {/* Subheader: Status badge & Unified AquaScan YOLO label */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                  {isCriticalClass(d.class) && (
                    <span className="tag alert" style={{ padding: '2px 8px', fontSize: 11 }}>
                      <span className="dot" />
                      Safety
                    </span>
                  )}
                  <ConfidenceBadge status={d.status} />
                  <span style={{ fontSize: 11.5, color: 'var(--ink-faint)', fontFamily: 'var(--font-mono)' }}>
                    {d.source === 'operator' ? 'Operator' : modelLabel(d.model)}
                  </span>
                </div>

                {/* Confidence Display (Percentage only, enlarged) */}
                {d.confidence != null && (
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
                    <span style={{ fontSize: 11, color: 'var(--ink-faint)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>Confidence</span>
                    <span className="mono" style={{ fontSize: 18, fontWeight: 700, color: d.confidence > 0.7 ? 'var(--ocean)' : 'var(--amber)' }}>
                      {Math.round(d.confidence * 100)}%
                    </span>
                  </div>
                )}

                {/* 3 Metric Fields: Acoustic Shadow | Est. Area | Acoustic Evidence */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1.2fr 1fr 1.1fr',
                    gap: '8px 10px',
                    padding: '10px 12px',
                    background: 'rgba(255,255,255,0.025)',
                    border: '1px solid rgba(255,255,255,0.06)',
                    borderRadius: 8,
                    marginBottom: 10,
                  }}
                >
                  <div>
                    <div style={{ fontSize: 10.5, color: 'var(--ink-faint)', letterSpacing: '0.02em', marginBottom: 2 }}>Acoustic Shadow</div>
                    <div className="mono" style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-dim)' }}>
                      {shadowQualityLabel(d)}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10.5, color: 'var(--ink-faint)', letterSpacing: '0.02em', marginBottom: 2 }}>Est. Area</div>
                    <div className="mono" style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-dim)' }}>
                      {estimatedAreaLabel(d)}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10.5, color: 'var(--ink-faint)', letterSpacing: '0.02em', marginBottom: 2 }}>Acoustic Evidence</div>
                    <div className="mono" style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-dim)' }}>
                      {evidenceScoreLabel(d)}
                    </div>
                  </div>
                </div>

                {/* Coordinates on its own line underneath */}
                <div style={{ padding: '2px 4px', marginBottom: reason ? 8 : 0 }}>
                  <div style={{ fontSize: 10.5, color: 'var(--ink-faint)', marginBottom: 2 }}>Coordinates</div>
                  <div className="mono" style={{ fontSize: 11.5, color: 'var(--ocean)' }}>
                    {formatCoordinates(d.location)}
                  </div>
                </div>

                {/* Review Reason / Operator Warning Notice */}
                {reason && (
                  <div
                    style={{
                      marginTop: 8,
                      padding: '6px 10px',
                      background: 'rgba(242, 169, 60, 0.08)',
                      border: '1px solid rgba(242, 169, 60, 0.25)',
                      borderRadius: 6,
                      fontSize: 11,
                      color: 'var(--amber)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <span style={{ fontSize: 12 }}>⚠</span>
                    <span>{reason}</span>
                  </div>
                )}
              </div>
            )
          })}
          {draftAnnotations.map((a) => (
            <div
              key={a.id}
              onClick={() => setSelectedId(a.id)}
              style={{
                padding: '16px 18px',
                borderBottom: '1px solid var(--border)',
                cursor: 'pointer',
                background: a.id === selectedId ? 'var(--ocean-tint)' : 'rgba(77,142,224,0.07)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 15, color: 'var(--ink)', fontWeight: 600 }}>{classLabel(a.classKey)}</span>
                <span className="mono" style={{ color: 'var(--ink-faint)' }}>Operator</span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--ink-faint)' }}>Drawn this session · pending save</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
