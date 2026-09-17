import { useEffect, useState } from 'react'
import { MapContainer, TileLayer, CircleMarker, Tooltip, Popup, useMap } from 'react-leaflet'
import { useNavigate } from 'react-router-dom'
import { getDetections, getScanLines, getSites } from '../api/client.js'
import SonarCanvas from '../components/SonarCanvas.jsx'
import { classLabel } from '../utils/taxonomy.js'
import HeatmapLayer from '../components/HeatmapLayer.jsx'
import RiskLegend from '../components/RiskLegend.jsx'

const BASEMAPS = {
  map: {
    label: 'Map',
    layers: [
      {
        url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        attribution: '&copy; OpenStreetMap contributors',
      },
    ],
  },
  satellite: {
    label: 'Satellite',
    layers: [
      {
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics',
      },
    ],
  },
  hybrid: {
    label: 'Hybrid',
    layers: [
      {
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        attribution: 'Tiles &copy; Esri',
      },
      {
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
        attribution: 'Labels &copy; Esri',
      },
    ],
  },
}

const STATUS_COLOR = {
  'needs-review': '#cf5a42',
  'auto-confirmed': '#3f8a63',
  'operator-confirmed': '#1f6fa3',
  rejected: '#82969e',
}

export function getRiskColor(intensity) {
  if (intensity >= 0.85) return '#d32f2f'; // Critical
  if (intensity >= 0.70) return '#ff9800'; // High
  if (intensity >= 0.55) return '#ffeb3b'; // Moderate
  return '#2196f3';                        // Low
}

function MapBoundsUpdater({ detections }) {
  const map = useMap();
  useEffect(() => {
    const coords = detections.filter(d => d.location).map(d => [d.location.lat, d.location.lon]);
    if (coords.length > 0) {
      map.fitBounds(coords, { padding: [50, 50], maxZoom: 14 });
    }
  }, [detections, map]);
  return null;
}

export default function MapView() {
  const navigate = useNavigate()
  const [detections, setDetections] = useState([])
  const [lines, setLines] = useState([])
  const [sites, setSites] = useState([])
  const [basemap, setBasemap] = useState('map')

  // New state for Heatmap Feature
  const [activeView, setActiveView] = useState('detections') // 'detections' | 'risk' | 'both'
  const [riskZones, setRiskZones] = useState([])
  const [mapInstance, setMapInstance] = useState(null)

  // Fetch Existing API Data
  useEffect(() => {
    getDetections().then(setDetections)
    getScanLines().then(setLines)
    getSites().then(setSites)
  }, [])

  // Fetch Risk Heatmap Data
  useEffect(() => {
    fetch('/data/risk_data.json')
      .then((res) => res.json())
      .then((data) => setRiskZones(data.risk_zones || []))
      .catch((err) => console.error('Error loading risk data:', err));
  }, [])

  const imageByLineId = Object.fromEntries(lines.map((l) => [l.id, l.imageSrc]))
  const heatPoints = riskZones.map((z) => [z.lat, z.lng, z.intensity]);

  return (
    <div>
      {/* Header & View Controls */}
      <div style={{ marginBottom: 22, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: '16px' }}>
        <div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--ocean)', fontWeight: 600, marginBottom: 8 }}>
            Spatial view
          </div>
          <h1 style={{ fontSize: 28 }}>Detections by location</h1>
          <p style={{ color: 'var(--ink-dim)', marginTop: 8, maxWidth: '68ch' }}>
            {activeView === 'detections'
              ? 'GPS coordinates recovered from sonar navigation metadata, plotted on OpenStreetMap.'
              : activeView === 'risk'
                ? 'Predicted debris accumulation risk based on port proximity, fishing density, river discharge, and coastal bathymetry.'
                : 'Detections overlaid on predicted risk zones for survey prioritization.'}
          </p>
        </div>

        {/* View Toggle */}
        <div style={{ display: 'flex', gap: 4, background: 'var(--glass)', border: '1px solid var(--border-strong)', borderRadius: 10, padding: 4 }}>
          {['detections', 'risk', 'both'].map((view) => (
            <button
              key={view}
              onClick={() => setActiveView(view)}
              style={{
                border: 'none',
                borderRadius: 7,
                padding: '7px 12px',
                fontSize: 12.5,
                fontWeight: 600,
                cursor: 'pointer',
                background: activeView === view ? 'var(--ocean-deep)' : 'transparent',
                color: activeView === view ? '#fff' : 'var(--ink-dim)',
                textTransform: 'capitalize'
              }}
            >
              {view === 'both' ? 'Both (Overlay)' : view}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 18 }}>
        <div style={{ position: 'relative', height: 560, borderRadius: 'var(--radius)', overflow: 'hidden', border: '1px solid var(--border-strong)' }}>
          <MapContainer center={[12.5, 76]} zoom={6} style={{ width: '100%', height: '100%' }} ref={setMapInstance}>
            {activeView === 'detections' && <MapBoundsUpdater detections={detections} />}

            {BASEMAPS[basemap].layers.map((layer, i) => (
              <TileLayer key={`${basemap}-${i}`} url={layer.url} attribution={layer.attribution} />
            ))}

            {/* Heatmap Layer */}
            {(activeView === 'risk' || activeView === 'both') && heatPoints.length > 0 && (
              <HeatmapLayer points={heatPoints} />
            )}

            {/* Clickable High-Risk Zone Circles & Tooltips */}
            {(activeView === 'risk' || activeView === 'both') &&
              riskZones
                .filter((z) => z.intensity >= 0.65)
                .map((zone) => (
                  <CircleMarker
                    key={zone.id || `${zone.lat}-${zone.lng}`}
                    center={[zone.lat, zone.lng]}
                    radius={6}
                    pathOptions={{
                      fillColor: getRiskColor(zone.intensity),
                      color: '#ffffff',
                      weight: 1.5,
                      fillOpacity: 0.85,
                    }}
                  >
                    <Popup>
                      <div style={{ fontFamily: 'var(--font-body)', minWidth: 200, padding: 4 }}>
                        <div style={{ fontWeight: 'bold', fontSize: 14, color: 'var(--ink)', marginBottom: 4 }}>
                          {zone.zone_name}
                        </div>
                        <div style={{ display: 'inline-block', padding: '2px 6px', borderRadius: 4, fontSize: 11, fontWeight: 'bold', color: '#fff', backgroundColor: getRiskColor(zone.intensity), marginBottom: 8 }}>
                          {zone.risk_level} Risk — {(zone.intensity * 100).toFixed(0)}%
                        </div>
                        <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--ink-dim)', marginBottom: 4 }}>
                          Key Drivers:
                        </div>
                        <ul style={{ paddingLeft: 16, fontSize: 11, color: 'var(--ink-faint)', margin: 0, paddingBottom: 8 }}>
                          {zone.factors?.map((f, i) => <li key={i}>{f}</li>)}
                        </ul>
                      </div>
                    </Popup>
                  </CircleMarker>
                ))}

            {/* Original Sonar Detections Pins */}
            {(activeView === 'detections' || activeView === 'both') && detections.filter((d) => d.location).map((d) => (
              <CircleMarker
                key={d.id}
                center={[d.location.lat, d.location.lon]}
                radius={8}
                pathOptions={{
                  color: '#fff',
                  weight: 2,
                  fillColor: STATUS_COLOR[d.status] || '#1f6fa3',
                  fillOpacity: 0.9,
                }}
                eventHandlers={{
                  click: () => navigate(`/review/${d.lineId}`),
                  mouseover: (e) => e.target.setStyle({ radius: 11 }),
                  mouseout: (e) => e.target.setStyle({ radius: 8 }),
                }}
              >
                <Tooltip direction="top" offset={[0, -8]} opacity={1}>
                  <div style={{ fontFamily: 'var(--font-body)', width: 150 }}>
                    <div style={{ width: '100%', height: 90, borderRadius: 6, overflow: 'hidden', marginBottom: 6 }}>
                      <SonarCanvas imageSrc={imageByLineId[d.lineId]} seed={d.lineId} />
                    </div>
                    <div style={{ fontWeight: 600, fontSize: 12.5 }}>{classLabel(d.class)}</div>
                    <div className="mono" style={{ fontSize: 11, color: '#4c6672' }}>
                      {d.confidence != null ? `${(d.confidence * 100).toFixed(0)}%` : '—'} · {d.lineId}
                    </div>
                    <div style={{ fontSize: 10.5, color: '#82969e', marginTop: 3 }}>Click to open →</div>
                  </div>
                </Tooltip>
              </CircleMarker>
            ))}
          </MapContainer>

          {/* Basemap Switcher */}
          <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 1000, display: 'flex', gap: 4, background: 'var(--glass)', border: '1px solid var(--border-strong)', borderRadius: 10, padding: 4 }}>
            {Object.entries(BASEMAPS).map(([key, b]) => (
              <button
                key={key}
                type="button"
                onClick={() => setBasemap(key)}
                style={{
                  border: 'none',
                  borderRadius: 7,
                  padding: '7px 12px',
                  fontSize: 12.5,
                  fontWeight: 600,
                  cursor: 'pointer',
                  background: basemap === key ? 'var(--ocean-deep)' : 'transparent',
                  color: basemap === key ? '#fff' : 'var(--ink-dim)',
                }}
              >
                {b.label}
              </button>
            ))}
          </div>

          {/* Legends Container */}
          <div style={{ position: 'absolute', bottom: 12, left: 12, zIndex: 1000, display: 'flex', gap: 12 }}>
            {(activeView === 'detections' || activeView === 'both') && (
              <div style={{ background: 'var(--glass)', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '10px 14px', fontSize: 11.5, color: 'var(--ink-dim)' }}>
                <LegendRow color={STATUS_COLOR['needs-review']} label="Needs review" />
                <LegendRow color={STATUS_COLOR['auto-confirmed']} label="Auto-confirmed" />
                <LegendRow color={STATUS_COLOR['operator-confirmed']} label="Operator confirmed" />
                <LegendRow color={STATUS_COLOR.rejected} label="Rejected" />
              </div>
            )}

            {(activeView === 'risk' || activeView === 'both') && <RiskLegend />}
          </div>
        </div>

        {/* Dynamic Right Sidebar */}
        <div className="card">
          {activeView === 'risk' ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
                <h3 style={{ fontSize: 16 }}>Top Risk Zones</h3>
                <span style={{ fontSize: 12, color: 'var(--ink-faint)' }}>{riskZones.filter(z => z.intensity >= 0.8).length} critical</span>
              </div>
              <div style={{ overflowY: 'auto', maxHeight: '500px' }}>
                {[...riskZones]
                  .sort((a, b) => b.intensity - a.intensity)
                  .slice(0, 10)
                  .map((zone) => (
                    <div
                      key={zone.id || zone.zone_name}
                      onClick={() => mapInstance?.flyTo([zone.lat, zone.lng], 9)}
                      style={{ padding: '13px 18px', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div style={{ fontSize: 13.5, color: 'var(--ink)', marginBottom: 3, fontWeight: 500 }}>{zone.zone_name}</div>
                        <div style={{ fontSize: 10, fontWeight: 'bold', padding: '2px 6px', borderRadius: 4, color: '#fff', backgroundColor: getRiskColor(zone.intensity) }}>
                          {(zone.intensity * 100).toFixed(0)}%
                        </div>
                      </div>
                      <div className="mono" style={{ fontSize: 11, color: 'var(--ink-faint)' }}>
                        {zone.lat.toFixed(4)}°N, {zone.lng.toFixed(4)}°E
                      </div>
                    </div>
                  ))}
              </div>
            </>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
                <h3 style={{ fontSize: 16 }}>Sites</h3>
                <span style={{ fontSize: 12, color: 'var(--ink-faint)' }}>{sites.length} active</span>
              </div>
              <div style={{ overflowY: 'auto', maxHeight: '500px' }}>
                {sites.map((s) => (
                  <div key={s.name} style={{ padding: '13px 18px', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 13.5, color: 'var(--ink)', marginBottom: 3 }}>{s.name}</div>
                    <div className="mono" style={{ fontSize: 11, color: 'var(--ink-faint)' }}>
                      {s.lat.toFixed(4)}°N, {s.lon.toFixed(4)}°E — {s.flagged} flagged
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function LegendRow({ color, label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 5 }}>
      <span style={{ width: 9, height: 9, borderRadius: '50%', background: color, flex: 'none' }} />
      {label}
    </div>
  )
}