// Shared class + model + status vocabulary used across mock data, the
// annotation tool, and the Review/Reports tables — kept in one place so the
// frontend and the backend's CLASS_NAME_ALIASES (backend/main.py) stay in
// sync.
//
// crab_pot/shipwreck/mine/ghost_net/unknown_debris are the original debris
// taxonomy. human_in_water/airplane/non_mine_object were added after
// inspecting the actual model weights: the "shipwreck" model is really a
// 4-class model (also airplane, drowning_victim_human, mine) and the "mine"
// model outputs naval mine-countermeasures classes MILCO (mine-like
// contact) / NOMBO (non-mine bottom object — explicitly *not* a mine).
// Rather than mislabel those as shipwreck/mine, they're surfaced as their
// own classes.
export const DEBRIS_CLASSES = [
  { id: 0, key: 'crab_pot', label: 'Crab Pot' },
  { id: 1, key: 'shipwreck', label: 'Shipwreck' },
  { id: 2, key: 'mine', label: 'Mine' },
  { id: 3, key: 'ghost_net', label: 'Ghost Net' },
  { id: 4, key: 'unknown_debris', label: 'Unknown Debris' },
  { id: 5, key: 'human_in_water', label: 'Person in Water' },
  { id: 6, key: 'airplane', label: 'Airplane Wreckage' },
  { id: 7, key: 'non_mine_object', label: 'Non-Mine Object' },
]

const CLASS_BY_KEY = Object.fromEntries(DEBRIS_CLASSES.map((c) => [c.key, c]))

export function classLabel(key) {
  return CLASS_BY_KEY[key]?.label || key
}

export function classIdFor(key) {
  return CLASS_BY_KEY[key]?.id ?? -1
}

// A safety-critical class always demands operator attention — it bypasses
// the normal confidence-based auto-confirm tiering (see classifyConfidence)
// and gets a distinct box style in AnnotationTool regardless of status.
const CRITICAL_CLASSES = new Set(['human_in_water'])

export function isCriticalClass(key) {
  return CRITICAL_CLASSES.has(key)
}

// Per-class swatch for the Overview dashboard's class distribution chart.
// Text labels are always shown alongside these (never color-alone), so a
// little hue reuse across less-central classes is an acceptable tradeoff
// against inventing a large bespoke categorical ramp for an 8-class list.
const CLASS_COLOR = {
  crab_pot: 'var(--ocean)',
  shipwreck: 'var(--amber)',
  mine: 'var(--coral)',
  ghost_net: 'var(--sage)',
  unknown_debris: 'var(--ink-faint)',
  human_in_water: 'var(--alert)',
  airplane: 'var(--ocean-deep)',
  non_mine_object: 'var(--slate)',
}

export function classColor(key) {
  return CLASS_COLOR[key] || 'var(--ocean)'
}

// Only the three model *slots* the backend runs get a name-pattern match —
// ghost_net/unknown_debris/non_mine_object are operator- or discriminator-
// only classes with no model of their own, so they fall through to the
// generic label. human_in_water and airplane come from the shipwreck
// model's own file, so they still match /ship.?wreck/i via the backend's
// key-prefixed model_id (e.g. "shipwreck_ship-model") — the Model column
// will show "Shipwreck Detector" for those too, reflecting which .pt file
// actually produced them.
const MODEL_LABEL_PATTERNS = [
  { match: /crab.?pot/i, label: 'Crab Pot Detector' },
  { match: /ship.?wreck/i, label: 'Shipwreck Detector' },
  { match: /mine/i, label: 'Mine Detector' },
]

// Backend model identifiers look like "crabpot_yolo26n" — never shown as-is
// to operators. This maps any such id to the human-readable label.
// Unified YOLO model naming across cards
export function modelLabel(rawModelId) {
  if (!rawModelId || rawModelId === 'operator') return 'Operator'
  return 'AquaScan YOLO'
}

export const CONFIDENCE_AUTO_CONFIRM_THRESHOLD = 0.5

// classKey is optional so existing call sites without it keep working, but
// always pass it when known — a critical-class detection is always flagged
// for review no matter how confident the model is.
export function classifyConfidence(confidence, classKey) {
  if (isCriticalClass(classKey)) return 'needs-review'
  return confidence >= CONFIDENCE_AUTO_CONFIRM_THRESHOLD ? 'auto-confirmed' : 'needs-review'
}

// Detection-level status vocabulary (distinct from scan-line status).
export const DETECTION_STATUS = {
  'auto-confirmed': { label: 'Auto-confirmed', tone: 'ok' },
  'needs-review': { label: 'Needs Review', tone: 'warn' },
  'operator-confirmed': { label: 'Operator Confirmed', tone: 'info' },
  rejected: { label: 'Rejected', tone: 'crit' },
}

export function statusMeta(status) {
  return DETECTION_STATUS[status] || { label: status, tone: 'warn' }
}

// Subtle, non-garish row background tint for detection tables, keyed by the
// same tone vocabulary as the status badge.
const ROW_TINT = {
  ok: 'rgba(63,138,99,0.07)',
  warn: 'rgba(185,129,42,0.09)',
  info: 'rgba(31,111,163,0.07)',
  crit: 'rgba(207,90,66,0.08)',
}

export function statusRowTint(status) {
  return ROW_TINT[statusMeta(status).tone] || 'transparent'
}
