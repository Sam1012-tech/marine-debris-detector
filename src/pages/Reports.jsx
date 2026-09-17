import { useEffect, useMemo, useState } from 'react'
import { getSurvey, getDetections, getHealth, exportAnnotations } from '../api/client.js'
import { downloadReportCsv, downloadReportJson } from '../utils/exportReport.js'
import ConfidenceBadge from '../components/ConfidenceBadge.jsx'
import { classLabel, isCriticalClass, modelLabel, statusRowTint } from '../utils/taxonomy.js'

export default function Reports() {
  const [survey, setSurvey] = useState(null)
  const [detections, setDetections] = useState([])
  const [search, setSearch] = useState('')
  const [classFilter, setClassFilter] = useState('all')
  const [health, setHealth] = useState(null)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState(null)
  const [selected, setSelected] = useState(() => new Set())

  useEffect(() => {
    getSurvey().then(setSurvey)
    getDetections().then(setDetections)
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

  // Selection persists across filter changes, but only checkboxes for rows
  // currently visible drive "select all" — picking a class filter never
  // silently drops an already-selected row from the export.
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
          JSON or CSV for the backend or a GIS tool.
        </p>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
        <input
          className="mono"
          placeholder="Search by line, site or coordinates…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            flex: 1,
            minWidth: 220,
            background: 'var(--panel)',
            border: '1px solid var(--border-strong)',
            borderRadius: 10,
            padding: '10px 14px',
            fontSize: 13.5,
            fontFamily: 'var(--font-body)',
          }}
        />
        {classes.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setClassFilter(c)}
            style={{
              padding: '9px 14px',
              border: `1px solid ${classFilter === c ? 'var(--ocean)' : 'var(--border-strong)'}`,
              borderRadius: 10,
              fontSize: 13,
              fontWeight: classFilter === c ? 600 : 400,
              background: classFilter === c ? 'var(--ocean-tint)' : 'var(--panel)',
              color: classFilter === c ? 'var(--ocean-deep)' : 'var(--ink-dim)',
              cursor: 'pointer',
            }}
          >
            {c === 'all' ? 'All classes' : classLabel(c)}
          </button>
        ))}
        {selected.size > 0 && (
          <span className="mono" style={{ fontSize: 12, color: 'var(--ink-faint)' }}>
            {selected.size} selected
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              style={{ marginLeft: 8, background: 'none', border: 'none', color: 'var(--ocean)', cursor: 'pointer', font: 'inherit', padding: 0 }}
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
        <button type="button" className="btn" onClick={handleExportTraining} disabled={exporting}>
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
