export default function RiskLegend() {
  return (
    <div style={{ background: 'var(--glass)', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '10px 14px', fontSize: 11.5, color: 'var(--ink-dim)', maxWidth: 220 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', marginBottom: 8 }}>
        Debris Accumulation Risk
      </div>
      <div
        style={{
          width: '100%',
          height: 8,
          borderRadius: 999,
          background: 'linear-gradient(to right, #1a237e, #2196f3, #ffeb3b, #ff9800, #d32f2f)',
        }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--ink-faint)', marginTop: 5, fontWeight: 500 }}>
        <span>Low</span>
        <span>Mod</span>
        <span>High</span>
        <span>Crit</span>
      </div>
      <div style={{ marginTop: 8, paddingTop: 7, borderTop: '1px solid var(--border)', fontSize: 10, color: 'var(--ink-faint)', lineHeight: 1.35 }}>
        Aggregated from port proximity, fishing density, river inflow & bathymetry.
      </div>
    </div>
  )
}
