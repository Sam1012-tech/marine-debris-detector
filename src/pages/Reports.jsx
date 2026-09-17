import { useEffect, useMemo, useState } from 'react'
import { getSurvey, getDetections, getScanLines, getHealth, exportAnnotations } from '../api/client.js'
import { downloadReportCsv, downloadReportJson } from '../utils/exportReport.js'
import ConfidenceBadge from '../components/ConfidenceBadge.jsx'
import { classLabel, isCriticalClass, modelLabel, statusRowTint } from '../utils/taxonomy.js'
import { buildPdfReport } from '../utils/pdfReport.js'

export default function Reports() {
  const [survey, setSurvey] = useState(null)
  const [detections, setDetections] = useState([])
  const [scanLines, setScanLines] = useState([])
  const [search, setSearch] = useState('')
  const [classFilter, setClassFilter] = useState('all')
  const [health, setHealth] = useState(null)
  const [exporting, setExporting] = useState(false)
  const [generatingPdf, setGeneratingPdf] = useState(false)
  const [exportError, setExportError] = useState(null)
  const [selected, setSelected] = useState(() => new Set())

  useEffect(() => {
    getSurvey().then(setSurvey)
    getDetections().then(setDetections)
    getScanLines().then(setScanLines)
    getHealth().then(setHealth).catch(() => {})
  }, [])

  const classes = useMemo(() => ['all', ...new Set(detections.map((d) => d.class))], [detections])

  const filtered = detections.filter((d) => {
    if (classFilter !== 'all' && d.class !== classFilter) return false
    if (!search.trim()) return true
    const q = search.toLowerCase()
    return (
      d.lineId.toLowerCase().includes(q) ||
      d.site.toLowerCase().includes(q) ||
      `${d.location?.lat ?? ''}`.includes(q) ||
      `${d.location?.lon ?? ''}`.includes(q)
    )
  })

  const selectedInView = filtered.filter((d) => selected.has(d.id))
  const allVisibleSelected = filtered.length > 0 && selectedInView.length === filtered.length
  const exportSet = selected.size > 0 ? detections.filter((d) => selected.has(d.id)) : filtered

  const toggleRow = (id) => {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const toggleAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allVisibleSelected) {
        filtered.forEach((d) => next.delete(d.id))
      } else {
        filtered.forEach((d) => next.add(d.id))
      }
      return next
    })
  }

  const handleExportTraining = async () => {
    setExporting(true)
    setExportError(null)
    try {
      await exportAnnotations()
    } catch (err) {
      setExportError(err.message || 'Export failed.')
    } finally {
      setExporting(false)
    }
  }

  const handleDirectPdfExport = async () => {
    setGeneratingPdf(true)
    setExportError(null)
    try {
      await buildPdfReport(survey, exportSet, scanLines)
    } catch (err) {
      console.error('PDF export failed:', err)
      setExportError(`PDF Export failed: ${err.message}`)
    } finally {
      setGeneratingPdf(false)
    }
  }

  const annotatedCount = health?.annotations?.image_count

  return (
    <div>
      <div style={{ marginBottom: 22 }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--ocean)', fontWeight: 600, marginBottom: 8 }}>
          Archive
        </div>
        <h1 style={{ fontSize: 28 }}>Detection reports</h1>
        <p style={{ color: 'var(--ink-dim)', marginTop: 8, maxWidth: '68ch' }}>
          Every flagged anomaly, with exact location, bounding dimensions, and classification — exportable as
          JSON, CSV, or executive PDF report for the backend or a GIS tool.
        </p>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
        <input
          className="mono"
          placeholder="Search by line, site or coordinates…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 280, height: 38 }}
        />
        <select
          value={classFilter}
          onChange={(e) => setClassFilter(e.target.value)}
          style={{ height: 38, padding: '0 12px' }}
        >
          {classes.map((c) => (
            <option key={c} value={c}>
              {c === 'all' ? 'All classes' : classLabel(c)}
            </option>
          ))}
        </select>
        {selected.size > 0 && (
          <span style={{ fontSize: 13, color: 'var(--ocean)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span>{selected.size} selected for export</span>
            <button
              type="button"
              className="btn ghost"
              onClick={() => setSelected(new Set())}
              style={{ fontSize: 12, padding: '3px 8px', height: 'auto' }}
            >
              Clear
            </button>
          </span>
        )}
        <button type="button" className="btn ghost" onClick={() => downloadReportCsv(survey, exportSet)}>
          Export CSV{selected.size > 0 ? ` (${selected.size})` : ''}
        </button>
        <button type="button" className="btn ghost" onClick={() => downloadReportJson(survey, exportSet)}>
          Export JSON{selected.size > 0 ? ` (${selected.size})` : ''}
        </button>
        <button
          id="export-pdf-btn"
          type="button"
          className="btn"
          onClick={handleDirectPdfExport}
          disabled={generatingPdf}
          style={{
            background: 'linear-gradient(135deg, #1b4f72 0%, #1b8fc9 100%)',
            border: 'none',
            gap: 6,
            minWidth: 140,
          }}
        >
          {generatingPdf ? 'Generating PDF…' : `🌊 Export PDF${selected.size > 0 ? ` (${selected.size})` : ''}`}
        </button>
        <button type="button" className="btn ghost" onClick={handleExportTraining} disabled={exporting}>
          {exporting
            ? 'Exporting…'
            : `Export Training Data${annotatedCount != null ? ` (${annotatedCount} annotated image${annotatedCount === 1 ? '' : 's'})` : ''}`}
        </button>
      </div>
      {exportError && <div style={{ marginBottom: 12, fontSize: 12.5, color: 'var(--coral)' }}>{exportError}</div>}

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAllVisible}
                    aria-label="Select all visible rows"
                  />
                </th>
                <th>Line</th>
                <th>Site</th>
                <th>Class</th>
                <th>Confidence</th>
                <th>Model</th>
                <th>Source</th>
                <th>Coordinates</th>
                <th>Bounding box</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((d) => (
                <tr key={d.id} className="row-hover" style={{ background: statusRowTint(d.status) }}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(d.id)}
                      onChange={() => toggleRow(d.id)}
                      aria-label={`Select detection ${d.id}`}
                    />
                  </td>
                  <td className="primary mono">{d.lineId}</td>
                  <td>{d.site}</td>
                  <td>
                    {classLabel(d.class)}
                    {isCriticalClass(d.class) && (
                      <span className="tag alert" style={{ marginLeft: 8 }}>
                        <span className="dot" />
                        Safety
                      </span>
                    )}
                  </td>
                  <td className="mono">{d.confidence != null ? d.confidence.toFixed(2) : '—'}</td>
                  <td>{d.source === 'operator' ? 'Operator' : modelLabel(d.model)}</td>
                  <td>{d.source === 'operator' ? 'Operator' : 'Model'}</td>
                  <td className="mono">
                    {d.location ? `${d.location.lat.toFixed(4)}, ${d.location.lon.toFixed(4)}` : '—'}
                  </td>
                  <td className="mono">
                    {d.boundingBoxM ? `${d.boundingBoxM.width}m × ${d.boundingBoxM.height}m` : '—'}
                  </td>
                  <td>
                    <ConfidenceBadge status={d.status} />
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={10} style={{ color: 'var(--ink-faint)', textAlign: 'center', padding: 24 }}>
                    No detections match this filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
