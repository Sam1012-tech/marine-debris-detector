import React, { useEffect, useRef, useState, useCallback } from 'react'

// Golden-blue colormap lookup table
// Maps dark acoustic shadow -> deep blue, high backscatter -> bright amber/gold
function buildSonarLUT() {
  const lut = new Uint8ClampedArray(256 * 4)
  for (let i = 0; i < 256; i++) {
    const n = i / 255
    lut[i * 4 + 0] = Math.min(255, Math.round(255 * Math.pow(n, 1.3) * 1.2)) // R (Amber/Gold)
    lut[i * 4 + 1] = Math.min(255, Math.round(200 * Math.pow(n, 1.6)))       // G
    lut[i * 4 + 2] = Math.min(255, Math.round(90 * (1 - n) + 30 * n))        // B (Blue shadow)
    lut[i * 4 + 3] = 255                                                      // Alpha
  }
  return lut
}
const SONAR_LUT = buildSonarLUT()

function toGray(img, w, h) {
  const oc = document.createElement('canvas')
  oc.width = w
  oc.height = h
  const ctx = oc.getContext('2d')
  ctx.drawImage(img, 0, 0, w, h)
  const d = ctx.getImageData(0, 0, w, h).data
  const g = new Uint8ClampedArray(w * h)
  for (let i = 0; i < w * h; i++) {
    g[i] = Math.round(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2])
  }
  return g
}

function colNorm(gray, w, h) {
  const out = new Uint8ClampedArray(w * h)
  for (let c = 0; c < w; c++) {
    let sum = 0
    for (let r = 0; r < h; r++) sum += gray[r * w + c]
    const mean = sum / h
    const tmp = new Float32Array(h)
    let mn = 1e9, mx = -1e9
    for (let r = 0; r < h; r++) {
      tmp[r] = gray[r * w + c] - mean
      if (tmp[r] < mn) mn = tmp[r]
      if (tmp[r] > mx) mx = tmp[r]
    }
    const rng = mx - mn || 1
    for (let r = 0; r < h; r++) {
      out[r * w + c] = Math.round(((tmp[r] - mn) / rng) * 255)
    }
  }
  return out
}

function applyCLAHE(gray, w, h, clip = 2.5, tw = 8, th = 8) {
  const out = new Uint8ClampedArray(w * h)
  const nx = Math.ceil(w / tw), ny = Math.ceil(h / th)
  const cdfs = Array.from({ length: ny }, () => [])
  
  for (let ty = 0; ty < ny; ty++) {
    for (let tx = 0; tx < nx; tx++) {
      const hist = new Float32Array(256)
      let cnt = 0
      for (let r = ty * th; r < Math.min((ty + 1) * th, h); r++) {
        for (let c = tx * tw; c < Math.min((tx + 1) * tw, w); c++) {
          hist[gray[r * w + c]]++
          cnt++
        }
      }
      const lim = (clip * cnt) / 256
      let exc = 0
      for (let v = 0; v < 256; v++) {
        if (hist[v] > lim) {
          exc += hist[v] - lim
          hist[v] = lim
        }
      }
      const add = exc / 256
      for (let v = 0; v < 256; v++) hist[v] = Math.min(lim, hist[v] + add)
      const cdf = new Float32Array(256)
      cdf[0] = hist[0]
      for (let v = 1; v < 256; v++) cdf[v] = cdf[v - 1] + hist[v]
      const cmin = cdf.find((x) => x > 0) || 0
      for (let v = 0; v < 256; v++) {
        cdf[v] = Math.round(((cdf[v] - cmin) / (cnt - cmin || 1)) * 255)
      }
      cdfs[ty].push(cdf)
    }
  }

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const px = gray[r * w + c]
      const txF = c / tw - 0.5, tyF = r / th - 0.5
      const tx0 = Math.max(0, Math.min(nx - 1, Math.floor(txF)))
      const ty0 = Math.max(0, Math.min(ny - 1, Math.floor(tyF)))
      const tx1 = Math.min(nx - 1, tx0 + 1)
      const ty1 = Math.min(ny - 1, ty0 + 1)
      const fx = txF - tx0, fy = tyF - ty0
      out[r * w + c] = Math.min(255, Math.round(
        cdfs[ty0][tx0][px] * (1 - fx) * (1 - fy) +
        cdfs[ty0][tx1][px] * fx * (1 - fy) +
        cdfs[ty1][tx0][px] * (1 - fx) * fy +
        cdfs[ty1][tx1][px] * fx * fy
      ))
    }
  }
  return out
}

function bc(gray, a = 1.15, b = 5) {
  const out = new Uint8ClampedArray(gray.length)
  for (let i = 0; i < gray.length; i++) {
    out[i] = Math.min(255, Math.max(0, Math.round(a * gray[i] + b)))
  }
  return out
}

function applyLUT(gray, w, h) {
  const rgba = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    const v = gray[i]
    rgba[i * 4 + 0] = SONAR_LUT[v * 4 + 0]
    rgba[i * 4 + 1] = SONAR_LUT[v * 4 + 1]
    rgba[i * 4 + 2] = SONAR_LUT[v * 4 + 2]
    rgba[i * 4 + 3] = 255
  }
  return rgba
}

function putRGBA(canvas, rgba, w, h) {
  if (!canvas) return
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.putImageData(new ImageData(rgba, w, h), 0, 0)
}

function drawDetection(canvas, rgba, w, h, box, label) {
  if (!canvas) return
  putRGBA(canvas, rgba, w, h)
  if (!box) return
  const ctx = canvas.getContext('2d')
  ctx.strokeStyle = '#ff3c00'
  ctx.lineWidth = 2.5
  ctx.strokeRect(box.x1, box.y1, box.x2 - box.x1, box.y2 - box.y1)
  if (label) {
    ctx.font = 'bold 11px IBM Plex Mono, monospace'
    const tw = ctx.measureText(label).width
    ctx.fillStyle = '#ff3c00'
    ctx.fillRect(box.x1, Math.max(0, box.y1 - 22), tw + 12, 22)
    ctx.fillStyle = '#ffffff'
    ctx.fillText(label, box.x1 + 6, Math.max(15, box.y1 - 7))
  }
}

function drawAcoustic(canvas, rgba, w, h, box, dir) {
  if (!canvas) return
  putRGBA(canvas, rgba, w, h)
  if (!box) return
  const ctx = canvas.getContext('2d')
  const { x1, y1, x2, y2 } = box
  let sx1, sy1, sx2, sy2
  if (dir === 'right') {
    sx1 = x2; sx2 = Math.min(w, x2 + Math.round((x2 - x1) * 1.6)); sy1 = y1; sy2 = y2
  } else if (dir === 'left') {
    sx1 = Math.max(0, x1 - Math.round((x2 - x1) * 1.6)); sx2 = x1; sy1 = y1; sy2 = y2
  } else if (dir === 'down') {
    sx1 = x1; sx2 = x2; sy1 = y2; sy2 = Math.min(h, y2 + Math.round((y2 - y1) * 1.6))
  } else {
    sx1 = x1; sx2 = x2; sy1 = Math.max(0, y1 - Math.round((y2 - y1) * 1.6)); sy2 = y1
  }

  // Shadow corridor
  ctx.save()
  ctx.globalAlpha = 0.35
  ctx.fillStyle = '#0055dd'
  ctx.fillRect(sx1, sy1, sx2 - sx1, sy2 - sy1)
  ctx.restore()

  ctx.strokeStyle = 'rgba(0,180,255,0.85)'
  ctx.lineWidth = 1.5
  ctx.strokeRect(sx1, sy1, sx2 - sx1, sy2 - sy1)

  // Target bounding box
  ctx.strokeStyle = '#00e5ff'
  ctx.lineWidth = 2.5
  ctx.strokeRect(x1, y1, x2 - x1, y2 - y1)

  // Acoustic axis arrow
  const cy = (y1 + y2) / 2
  ctx.strokeStyle = '#ffd700'
  ctx.lineWidth = 2.5
  ctx.beginPath()
  if (dir === 'right') { ctx.moveTo(x2, cy); ctx.lineTo(sx2, cy) }
  else if (dir === 'left') { ctx.moveTo(x1, cy); ctx.lineTo(sx1, cy) }
  ctx.stroke()

  ctx.fillStyle = '#ffd700'
  ctx.beginPath()
  if (dir === 'right') {
    ctx.moveTo(sx2, cy); ctx.lineTo(sx2 - 10, cy - 6); ctx.lineTo(sx2 - 10, cy + 6)
  } else if (dir === 'left') {
    ctx.moveTo(sx1, cy); ctx.lineTo(sx1 + 10, cy - 6); ctx.lineTo(sx1 + 10, cy + 6)
  }
  ctx.fill()

  // High contrast text box / badge for shadow direction (avoid unreadable blue text)
  const shadowText = `SHADOW: ${dir.toUpperCase()}`
  ctx.font = 'bold 11px IBM Plex Mono, monospace'
  const stw = ctx.measureText(shadowText).width
  const badgeX = Math.max(4, Math.min(w - stw - 16, sx1))
  const badgeY = Math.max(22, sy1 > 26 ? sy1 - 8 : sy2 + 22)

  // Dark pill box with golden border and bright text
  ctx.fillStyle = 'rgba(6, 15, 23, 0.94)'
  ctx.fillRect(badgeX, badgeY - 16, stw + 14, 20)
  ctx.strokeStyle = '#f2a93c'
  ctx.lineWidth = 1.5
  ctx.strokeRect(badgeX, badgeY - 16, stw + 14, 20)

  ctx.fillStyle = '#fbd38d'
  ctx.fillText(shadowText, badgeX + 7, badgeY - 2)
}

function Arrow() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', alignSelf: 'center', flexShrink: 0, padding: '0 8px', paddingBottom: 42 }}>
      <svg width="38" height="22" viewBox="0 0 38 22" fill="none">
        <line x1="0" y1="11" x2="28" y2="11" stroke="#c8960c" strokeWidth="2.5" strokeDasharray="5 3" />
        <polygon points="28,5 38,11 28,17" fill="#c8960c" />
      </svg>
    </div>
  )
}

function PanelCard({ step, label, sub, accent, canvasRef, active, onClick }) {
  return (
    <div
      onClick={onClick}
      onMouseEnter={(e) => { if (onClick) e.currentTarget.style.transform = 'translateY(-4px)' }}
      onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)' }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        flexShrink: 0,
        width: 220,
        cursor: 'pointer',
        transition: 'transform 0.18s ease',
      }}
    >
      <div
        style={{
          fontFamily: 'IBM Plex Mono, monospace',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: accent,
          background: `${accent}22`,
          padding: '3px 10px',
          borderRadius: 4,
          marginBottom: 8,
          border: `1px solid ${accent}44`,
        }}
      >
        {step}
      </div>
      <div
        style={{
          width: 220,
          height: 270,
          background: '#060e15',
          border: active ? `2px solid ${accent}` : '1px solid var(--border-strong)',
          borderRadius: 10,
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'border-color 0.18s, box-shadow 0.18s',
          boxShadow: active ? `0 0 22px ${accent}55` : '0 2px 8px rgba(15,39,51,0.12)',
        }}
      >
        <canvas
          ref={canvasRef}
          style={{
            display: 'block',
            maxWidth: '100%',
            maxHeight: '100%',
            imageRendering: 'pixelated',
          }}
        />
      </div>
      <div style={{ marginTop: 10, fontSize: 12.5, fontWeight: 700, color: 'var(--ink)', textAlign: 'center', lineHeight: 1.3 }}>
        {label}
      </div>
      {sub && (
        <div style={{ marginTop: 4, fontSize: 10.5, color: 'var(--ink-faint)', fontFamily: 'IBM Plex Mono, monospace', textAlign: 'center', lineHeight: 1.4 }}>
          {sub}
        </div>
      )}
    </div>
  )
}

const STAGE_INFO = [
  {
    title: 'Waterfall Image (Raw)',
    body: 'Raw sonar input with the golden-blue sonar LUT applied. Deep acoustic shadows map to indigo-blue; high-energy target returns map to amber-gold. Translated from get_sonar_colormap() in the Python pipeline.',
    params: [['LUT', 'Blue shadow to Amber-Gold'], ['BC', 'alpha=1.15 beta=+5']],
  },
  {
    title: 'Column Normalisation',
    body: 'Per-column mean subtraction removes vertical waterfall striping artefacts inherent to side-scan sonar. Each column is independently rescaled to 0-255. Equivalent to column_normalize() in the Python code.',
    params: [['Op', 'col -= mean; rescale 0-255'], ['Scope', 'Per-column independently']],
  },
  {
    title: 'CLAHE + Contrast Boost',
    body: 'Contrast Limited Adaptive Histogram Equalisation enhances local contrast in shadowed and bright zones independently, preventing highlight blowout. A brightness-contrast pass is applied after: alpha=1.15, beta=+5.',
    params: [['Clip limit', '2.5'], ['Tile', '8x8 px'], ['BC', 'alpha=1.15, beta=+5']],
  },
  {
    title: 'YOLO Detection',
    body: 'The CLAHE-enhanced image goes through YOLOv8 (3-weight ensemble). The top-confidence detection is drawn with a coral bounding box and a class/confidence label tag. NMS is applied server-side across all model outputs.',
    params: [['Model', 'YOLOv8 ensemble'], ['NMS IoU', '0.45'], ['Min conf', '0.25']],
  },
  {
    title: 'Acoustic Shadow Detection',
    body: 'The acoustic context post-processor looks for a shadow corridor adjacent to the YOLO box. The shadow region (blue fill) is 1.6x the bounding box dimension in the inferred direction. A gold arrow marks the acoustic axis.',
    params: [['Shadow', '1.6x bbox extent'], ['Target', 'Cyan outline'], ['Axis', 'Gold arrow']],
  },
]

function InfoDrawer({ stage, onClose }) {
  if (stage === null || stage === undefined) return null
  const info = STAGE_INFO[stage]
  if (!info) return null

  return (
    <div
      style={{
        marginTop: 18,
        background: 'var(--panel-alt)',
        border: '1px solid var(--border-strong)',
        borderRadius: 10,
        padding: '16px 20px',
        position: 'relative',
        animation: 'slideDown 0.2s ease',
      }}
    >
      <button
        onClick={onClose}
        style={{
          position: 'absolute',
          top: 12,
          right: 14,
          background: 'none',
          border: 'none',
          color: 'var(--ink-faint)',
          fontSize: 18,
          cursor: 'pointer',
          lineHeight: 1,
        }}
      >
        x
      </button>
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)', marginBottom: 8 }}>{info.title}</div>
      <p style={{ margin: '0 0 12px', fontSize: 12.5, color: 'var(--ink-dim)', lineHeight: 1.65 }}>{info.body}</p>
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
        {info.params.map((p) => (
          <div key={p[0]} style={{ fontSize: 11, fontFamily: 'IBM Plex Mono, monospace' }}>
            <span style={{ color: 'var(--ink-faint)' }}>{p[0]} </span>
            <span style={{ color: 'var(--ink)', fontWeight: 600 }}>{p[1]}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function PipelineVisualizer({ imageSrc, detections }) {
  const [ready, setReady] = useState(false)
  const [activeStage, setActiveStage] = useState(null)

  const cRaw = useRef(null)
  const cPreA = useRef(null)
  const cPreB = useRef(null)
  const cDet = useRef(null)
  const cAc = useRef(null)

  const dets = detections || []

  const render = useCallback(() => {
    if (!imageSrc) return
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const ratio = img.naturalHeight / img.naturalWidth
      // Increased canvas render resolution to 220px width for higher fidelity
      const dW = 220
      const dH = Math.round(dW * ratio)

      const g = toGray(img, dW, dH)
      const raw = bc(g)
      const cn = colNorm(g, dW, dH)
      const cl = applyCLAHE(cn, dW, dH)
      const enh = bc(cl)

      if (cRaw.current) putRGBA(cRaw.current, applyLUT(raw, dW, dH), dW, dH)
      if (cPreA.current) putRGBA(cPreA.current, applyLUT(cn, dW, dH), dW, dH)
      if (cPreB.current) putRGBA(cPreB.current, applyLUT(enh, dW, dH), dW, dH)

      const top = dets.reduce((b, d) => ((d.confidence || 0) > (b ? (b.confidence || 0) : 0) ? d : b), null)
      let box = null
      if (top && top.bboxPx) {
        const sc = dW / img.naturalWidth
        box = {
          x1: Math.round(top.bboxPx.x1 * sc),
          y1: Math.round(top.bboxPx.y1 * sc),
          x2: Math.round(top.bboxPx.x2 * sc),
          y2: Math.round(top.bboxPx.y2 * sc),
        }
      } else if (top && top.bboxPct) {
        box = {
          x1: Math.round(top.bboxPct.left * dW),
          y1: Math.round(top.bboxPct.top * dH),
          x2: Math.round((top.bboxPct.left + top.bboxPct.width) * dW),
          y2: Math.round((top.bboxPct.top + top.bboxPct.height) * dH),
        }
      } else if (dets.length > 0) {
        box = {
          x1: Math.round(dW * 0.28),
          y1: Math.round(dH * 0.22),
          x2: Math.round(dW * 0.72),
          y2: Math.round(dH * 0.78),
        }
      }

      const confLabel = top ? `${top.class || 'Target'} ${(top.confidence || 0).toFixed(2)}` : ''
      const dir = (top && top.shadow_direction) ? top.shadow_direction : 'right'

      if (cDet.current) drawDetection(cDet.current, applyLUT(enh, dW, dH).slice(), dW, dH, box, confLabel)
      if (cAc.current) drawAcoustic(cAc.current, applyLUT(enh, dW, dH).slice(), dW, dH, box, dir)

      setReady(true)
    }
    img.onerror = () => {
      setReady(false)
    }
    img.src = imageSrc
  }, [imageSrc, dets.length])

  useEffect(() => {
    setReady(false)
    setActiveStage(null)
    if (imageSrc) render()
  }, [imageSrc, render])

  if (!imageSrc) return null

  const PANELS = [
    { step: '01 Raw', label: 'Waterfall Image', sub: 'Golden-blue LUT', accent: '#c8960c', ref: cRaw, idx: 0 },
    { step: '02a Pre-proc', label: 'Column Normalisation', sub: 'Stripe removal', accent: '#d4a520', ref: cPreA, idx: 1 },
    { step: '02b Pre-proc', label: 'CLAHE + Contrast', sub: 'clipLimit=2.5  a=1.15', accent: '#d4a520', ref: cPreB, idx: 2 },
    { step: '03 YOLO', label: 'Detection Image', sub: dets[0] ? `Conf ${(dets[0].confidence || 0).toFixed(2)}` : 'No detections', accent: '#ff3c00', ref: cDet, idx: 3 },
    { step: '04 Post-proc', label: 'Acoustic Shadow Detection', sub: 'Shadow corridor + axis', accent: '#f2a93c', ref: cAc, idx: 4 },
  ]

  return (
    <div
      style={{
        marginTop: 28,
        padding: '24px 26px 26px',
        background: 'var(--panel)',
        border: '1px solid var(--border-strong)',
        borderRadius: 14,
        boxShadow: '0 4px 20px rgba(15,39,51,0.06)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ position: 'relative', width: 32, height: 32, flexShrink: 0 }}>
            <div className="sonar-ping" style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '1.5px solid rgba(200,150,12,0.5)' }} />
            <div style={{ position: 'absolute', inset: 5, borderRadius: '50%', background: 'rgba(200,150,12,0.12)', border: '1.5px solid #c8960c', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#c8960c" strokeWidth="2.5">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
              </svg>
            </div>
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)', letterSpacing: '0.02em' }}>Detection Pipeline</div>
            <div style={{ fontSize: 11, color: 'var(--ink-faint)', fontFamily: 'IBM Plex Mono, monospace', marginTop: 2 }}>Click any stage for details</div>
          </div>
        </div>
        {ready ? (
          <span style={{ fontSize: 11.5, color: '#4ddb95', fontFamily: 'IBM Plex Mono, monospace', display: 'flex', alignItems: 'center', gap: 6 }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            Rendered
          </span>
        ) : (
          <span style={{ fontSize: 11.5, color: '#c8960c', fontFamily: 'IBM Plex Mono, monospace', display: 'flex', alignItems: 'center', gap: 6 }}>
            <svg className="sonar-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
            </svg>
            Processing...
          </span>
        )}
      </div>

      <div style={{ overflowX: 'auto', paddingBottom: 6 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 0, minWidth: 'max-content', padding: '6px 2px' }}>
          {PANELS.map((p, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center' }}>
              <PanelCard
                step={p.step}
                label={p.label}
                sub={p.sub}
                accent={p.accent}
                canvasRef={p.ref}
                active={activeStage === p.idx}
                onClick={() => setActiveStage((v) => (v === p.idx ? null : p.idx))}
              />
              {i < PANELS.length - 1 && <Arrow />}
            </div>
          ))}
        </div>
      </div>

      <InfoDrawer stage={activeStage} onClose={() => setActiveStage(null)} />

      <style>{`
        @keyframes sonar-ping { 0%{transform:scale(1);opacity:.8} 75%,100%{transform:scale(2);opacity:0} }
        @keyframes sonar-spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
        @keyframes slideDown  { from{opacity:0;transform:translateY(-6px)} to{opacity:1;transform:translateY(0)} }
        .sonar-ping { animation: sonar-ping 2.4s cubic-bezier(0,0,0.2,1) infinite; }
        .sonar-spin { animation: sonar-spin 1s linear infinite; }
      `}</style>
    </div>
  )
}