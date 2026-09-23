// PdfExportModal — Section-toggle dialog for AquaScan PDF report generation.
// Shown when the user clicks "Export PDF" on the Reports page.
// Respects existing row checkbox selection (exportSet).

import { useState } from 'react'
import { buildPdfReport } from '../utils/pdfReport.js'

const SECTIONS = [
  {
    id: 'includeSonarOverview',
    label: 'Sonar Overview (Page 1)',
    desc: 'Side-by-side raw side-scan feed and processed target overlay.',
    icon: '🛰️',
    default: true,
  },
  {
    id: 'includeDetectionSummary',
    label: 'Acoustic Target Table & Inventory',
    desc: 'Clean table of all detected targets with class breakdown, confidence, hazard level, bounding box, and coordinates.',
    icon: '📊',
    default: true,
  },
  {
    id: 'includeGeospatialOverview',
    label: 'Geospatial Trackline Map',
    desc: 'Vector hydrographic chart with survey vessel trackline and plotted target hotspots.',
    icon: '🗺️',
    default: true,
  },
  {
    id: 'includeDetectionDetails',
    label: 'Priority Target Cards',
    desc: 'Individual cards with target sonar crops and acoustic evidence for critical hazards.',
    icon: '🔍',
    default: false,
  },
  {
    id: 'includeReviewQueue',
    label: 'Operator Verification Queue',
    desc: 'Pending verification actions and hydrographic check reasons.',
    icon: '⚠️',
    default: false,
  },
  {
    id: 'includeModelInfo',
    label: 'Model & Hydrographic Setup',
    desc: 'AI neural classifier weights, 640x640 window resolution, CLAHE contrast, and WGS84 dead-reckoning telemetry.',
    icon: '⚙️',
    default: false,
  },
  {
    id: 'includeExportedData',
    label: 'Exported Telemetry Formats',
    desc: 'Reference to CSV, JSON telemetry, and YOLO retraining packages.',
    icon: '📁',
    default: false,
  },
]

export default function PdfExportModal({ survey, detections, scanLines, exportSet, selectedCount, onClose }) {
  const [sections, setSections] = useState(() =>
    Object.fromEntries(SECTIONS.map(s => [s.id, s.default]))
  )
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState(null)

  const toggle = (id) => setSections(prev => ({ ...prev, [id]: !prev[id] }))

  const handleGenerate = async () => {
    setGenerating(true)
    setError(null)
    try {
      await buildPdfReport(survey, exportSet, scanLines, sections)
      onClose()
    } catch (err) {
      console.error('PDF generation failed', err)
      setError(`PDF generation failed: ${err.message}`)
    } finally {
      setGenerating(false)
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={generating ? undefined : onClose}
        style={{
          position: 'fixed', inset: 0,
          background: 'rgba(4,18,26,0.82)',
          backdropFilter: 'blur(4px)',
          zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        {/* Modal */}
        <div
          onClick={e => e.stopPropagation()}
          style={{
            background: 'var(--panel)',
            border: '1px solid var(--border-strong)',
            borderRadius: 16,
            width: '100%',
            maxWidth: 540,
            maxHeight: '90vh',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '0 24px 80px rgba(0,0,0,0.7)',
          }}
        >
          {/* Header */}
          <div style={{
            padding: '20px 24px 16px',
            borderBottom: '1px solid var(--border)',
            background: 'rgba(11,32,48,0.9)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  letterSpacing: '.1em',
                  textTransform: 'uppercase',
                  color: 'var(--ocean)',
                  fontWeight: 700,
                  marginBottom: 4,
                }}>
                  Export PDF Report
                </div>
                <h2 style={{ fontSize: 20, margin: 0, color: 'var(--ink)' }}>
                  🌊 AquaScan Survey Report
                </h2>
              </div>
              <button
                type="button"
                onClick={onClose}
                disabled={generating}
                aria-label="Close modal"
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--ink-dim)',
                  cursor: 'pointer',
                  fontSize: 20,
                  padding: 4,
                  lineHeight: 1,
                }}
              >
                ✕
              </button>
            </div>

            {/* Export scope badge */}
            <div style={{
              marginTop: 12,
              padding: '7px 12px',
              background: 'rgba(27,143,201,0.12)',
              border: '1px solid rgba(27,143,201,0.3)',
              borderRadius: 8,
              fontSize: 12.5,
              color: 'var(--ocean)',
              fontWeight: 500,
            }}>
              {selectedCount > 0
                ? `Exporting ${selectedCount} selected detection${selectedCount !== 1 ? 's' : ''}`
                : `Exporting all ${detections.length} visible detections`}
              {' '}<span style={{ color: 'var(--ink-faint)', fontWeight: 400 }}>· Survey: {survey?.id || 'Unknown'}</span>
            </div>
          </div>

          {/* Section toggles */}
          <div style={{ padding: '16px 24px', overflowY: 'auto', flex: 1 }}>
            <p style={{ fontSize: 12.5, color: 'var(--ink-dim)', marginBottom: 14, marginTop: 0 }}>
              Select which sections to include in the PDF report:
            </p>

            {/* Survey Summary is always included */}
            <div style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 12,
              padding: '10px 12px',
              borderRadius: 10,
              marginBottom: 6,
              background: 'rgba(27,143,201,0.08)',
              border: '1px solid rgba(27,143,201,0.2)',
              opacity: 0.75,
            }}>
              <div style={{ fontSize: 18, lineHeight: 1.3 }}>📋</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)' }}>
                  Survey Summary
                  <span style={{
                    marginLeft: 8,
                    fontSize: 10,
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--ocean)',
                    background: 'rgba(27,143,201,0.15)',
                    padding: '1px 6px',
                    borderRadius: 4,
                  }}>Always included</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--ink-faint)', marginTop: 2 }}>
                  Survey metadata, stat cards, vessel and area information.
                </div>
              </div>
            </div>

            {SECTIONS.map(s => (
              <label
                key={s.id}
                htmlFor={`pdf-section-${s.id}`}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 12,
                  padding: '10px 12px',
                  borderRadius: 10,
                  marginBottom: 6,
                  cursor: 'pointer',
                  background: sections[s.id] ? 'rgba(11,32,48,0.9)' : 'transparent',
                  border: `1px solid ${sections[s.id] ? 'var(--border-strong)' : 'var(--border)'}`,
                  transition: 'all 0.15s ease',
                }}
              >
                <input
                  type="checkbox"
                  id={`pdf-section-${s.id}`}
                  checked={sections[s.id]}
                  onChange={() => toggle(s.id)}
                  style={{ marginTop: 3, accentColor: 'var(--ocean)', width: 15, height: 15, cursor: 'pointer', flexShrink: 0 }}
                />
                <div style={{ fontSize: 18, lineHeight: 1.3, flexShrink: 0 }}>{s.icon}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: sections[s.id] ? 'var(--ink)' : 'var(--ink-dim)' }}>
                    {s.label}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--ink-faint)', marginTop: 2 }}>
                    {s.desc}
                  </div>
                </div>
              </label>
            ))}
          </div>

          {/* Error */}
          {error && (
            <div style={{ padding: '0 24px 8px', fontSize: 12, color: 'var(--coral)' }}>
              {error}
            </div>
          )}

          {/* Footer actions */}
          <div style={{
            padding: '16px 24px',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            gap: 10,
            justifyContent: 'flex-end',
            background: 'rgba(11,32,48,0.9)',
          }}>
            <button
              type="button"
              onClick={onClose}
              disabled={generating}
              className="btn ghost"
            >
              Cancel
            </button>
            <button
              id="pdf-generate-btn"
              type="button"
              onClick={handleGenerate}
              disabled={generating}
              className="btn"
              style={{
                background: generating ? 'var(--ocean-deep)' : undefined,
                minWidth: 160,
                position: 'relative',
              }}
            >
              {generating ? (
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{
                    display: 'inline-block',
                    width: 13,
                    height: 13,
                    border: '2px solid rgba(255,255,255,0.3)',
                    borderTopColor: 'white',
                    borderRadius: '50%',
                    animation: 'pdf-spin 0.7s linear infinite',
                  }} />
                  Generating PDF…
                </span>
              ) : (
                `Generate PDF${selectedCount > 0 ? ` (${selectedCount})` : ''}`
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Spinner keyframe */}
      <style>{`@keyframes pdf-spin { to { transform: rotate(360deg); } }`}</style>
    </>
  )
}
