// Pure helpers for the progress mod: the per-session record, how percent and
// minutes left are worked out, the estimate prompt and its parsing, activity
// labels and which records to show. Free of `$`.

// 'error': the turn ended on an API error or a refusal (shown red until the
// session's next task); 'stopped': the person interrupted (not shown).
export type TaskState = 'running' | 'done' | 'stopped' | 'error'
export type Waiting = 'decision' | 'permission'
export type ErrorKind = 'api' | 'refusal'

export type SessionRecord = {
  id: string
  project: string
  task: string
  state: TaskState
  startedAt: number
  updatedAt: number
  // The main-loop turn this task runs in; a turn.complete for another turn
  // (a subagent's, a stale one) does not close it.
  turnId?: string
  // Set while the task waits on the person: a question or plan to approve
  // ('decision'), or a permission dialog ('permission').
  waiting?: Waiting
  // Why the turn ended when state is 'error'.
  error?: ErrorKind
  // Tool calls made on this task so far (the agent's steps).
  steps?: number
  // The highest percent a fork has estimated for this task (never lowered).
  estPercent?: number
  // Steps taken and time when the last estimate was made.
  estAtSteps?: number
  estAtTime?: number
  activity?: string
  todoDone?: number
  todoTotal?: number
  // Every estimate attempted on this task, newest last (capped at LOG_MAX).
  estimates?: EstimateEntry[]
  // Cells across the band where this session last drew, for layout checks.
  columns?: number
}

// What one estimate attempt came to: `ok` stored a percent; `late` answered
// after the task had ended (its percent kept here, not shown); the rest name
// why no percent came back.
export type EstimateOutcome = 'ok' | 'late' | 'nothing-to-fork' | 'api-error' | 'empty-reply' | 'parse-fail' | 'error' | string

export type EstimateEntry = {
  // When the fork was sent and how long it took, ms.
  at: number
  ms: number
  // Steps taken when it was sent.
  step: number
  outcome: EstimateOutcome
  percent?: number
  note?: string
}

export const LOG_MAX = 40
// At most this many task rows; the rest fold into one "another N" row.
export const MAX_ROWS = 3

export function logEstimate(list: readonly EstimateEntry[] | undefined, entry: EstimateEntry): EstimateEntry[] {
  const next = [...(list ?? []), entry]
  return next.length > LOG_MAX ? next.slice(next.length - LOG_MAX) : next
}

// A running session rewrites its record every 5 seconds (the heartbeat, kept
// up through dialogs and long tool calls). One that has not written for this
// long (four missed beats) is lost: its process was killed or crashed, and
// its row goes away at once.
export const STALE_MS = 20_000
// Records untouched for this long are no longer shown at all.
export const FORGET_MS = 12 * 60 * 60_000
// Re-estimate after this many steps, or this long, past the last estimate.
export const REESTIMATE_STEPS = 3
export const REESTIMATE_MS = 60_000
// Never show more than this while the task still runs.
const CAP = 95

const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
const UNSEEN = /[\p{Cc}\p{Cf}\p{Cn}\p{Co}\p{Cs}]/gu

export function sanitize(text: string, max: number): string {
  const s = text.replace(ESCAPES, '').replace(/\s+/g, ' ').replace(UNSEEN, '').trim()
  const points = [...s]
  return points.length > max ? `${points.slice(0, max - 1).join('')}…` : s
}

// Percent done: the agent's own to-do list when it keeps one (at least two
// items), else the fork's estimate, capped while running.
export function shownPercent(r: SessionRecord): number | undefined {
  if (r.todoTotal !== undefined && r.todoDone !== undefined && r.todoTotal >= 2) {
    return Math.min(CAP, Math.round((Math.min(r.todoDone, r.todoTotal) / r.todoTotal) * 100))
  }
  if (r.estPercent !== undefined) return Math.min(CAP, Math.round(r.estPercent))
  return undefined
}

// Minutes left from the pace so far: elapsed time per percent point times
// the points still to go.
export function remainingMinutes(r: SessionRecord, now: number): number | undefined {
  if (r.state !== 'running') return undefined
  const p = shownPercent(r)
  if (p === undefined || p <= 0) return undefined
  const elapsedMin = (now - r.startedAt) / 60_000
  return Math.max(1, Math.round((elapsedMin * (100 - p)) / p))
}

// Estimate at the first step, then every REESTIMATE_STEPS steps, or after
// REESTIMATE_MS once at least one step has been taken since the last estimate
// (no step, no change: a task waiting on a dialog is not re-estimated).
export function needsEstimate(r: SessionRecord, now: number): boolean {
  if (r.state !== 'running' || r.steps === undefined || r.steps < 1) return false
  if (r.estAtSteps === undefined || r.estAtTime === undefined) return true
  const newSteps = r.steps - r.estAtSteps
  return newSteps >= REESTIMATE_STEPS || (newSteps >= 1 && now - r.estAtTime >= REESTIMATE_MS)
}

export const ESTIMATE_PROMPT =
  'This message is not a task; do not continue working and call no tools. Look at the task the user ' +
  'gave you BEFORE this message and estimate what percent of that whole job is done so far. Count the ' +
  'final reply you still have to write as remaining work; if only that final reply remains, answer 90-95. ' +
  'Answer with ONLY a JSON object, no prose, no code fence: {"percent_done": <whole number 0-100>}'

export function parsePercent(reply: string): number | undefined {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    const value = (JSON.parse(reply.slice(start, end + 1)) as { percent_done?: unknown }).percent_done
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : undefined
  } catch {
    return undefined
  }
}

// The percent only rises: a lower new estimate keeps the old one.
export function raise(previous: number | undefined, next: number): number {
  return previous === undefined ? next : Math.max(previous, next)
}

export function todoCounts(todos: unknown): { done: number; total: number } | undefined {
  if (!Array.isArray(todos)) return undefined
  const done = todos.filter(t => typeof t === 'object' && t !== null && (t as { status?: unknown }).status === 'completed').length
  return { done, total: todos.length }
}

// Rows the band shows: running tasks still writing, and errored ones.
export function shownRecords(records: readonly SessionRecord[], now: number): SessionRecord[] {
  return visible(records, now).filter(r => (r.state === 'running' && !isLost(r, now)) || r.state === 'error')
}

export function isLost(r: SessionRecord, now: number): boolean {
  return r.state === 'running' && now - r.updatedAt > STALE_MS
}

export function visible(records: readonly SessionRecord[], now: number): SessionRecord[] {
  return records.filter(r => now - r.updatedAt <= FORGET_MS)
}

export function parseRecord(text: string): SessionRecord | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || typeof r.task !== 'string' || typeof r.startedAt !== 'number' ||
    typeof r.updatedAt !== 'number') return null
  const state: TaskState = r.state === 'done' || r.state === 'stopped' || r.state === 'error' ? r.state : 'running'
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)
  return {
    id: r.id,
    project: typeof r.project === 'string' ? sanitize(r.project, 30) : '',
    task: sanitize(r.task, 40),
    state,
    startedAt: r.startedAt,
    updatedAt: r.updatedAt,
    turnId: typeof r.turnId === 'string' ? r.turnId : undefined,
    waiting: r.waiting === 'decision' || r.waiting === 'permission' ? r.waiting : undefined,
    error: r.error === 'api' || r.error === 'refusal' ? r.error : undefined,
    steps: num(r.steps),
    estPercent: num(r.estPercent),
    estAtSteps: num(r.estAtSteps),
    estAtTime: num(r.estAtTime),
    activity: typeof r.activity === 'string' ? sanitize(r.activity, 50) : undefined,
    todoDone: num(r.todoDone),
    todoTotal: num(r.todoTotal),
    estimates: parseEstimates(r.estimates),
    columns: num(r.columns),
  }
}

function parseEstimates(raw: unknown): EstimateEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: EstimateEntry[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const x = item as Record<string, unknown>
    if (typeof x.at !== 'number' || typeof x.ms !== 'number' || typeof x.step !== 'number' || typeof x.outcome !== 'string') continue
    out.push({
      at: x.at, ms: x.ms, step: x.step, outcome: x.outcome,
      percent: typeof x.percent === 'number' ? x.percent : undefined,
      note: typeof x.note === 'string' ? sanitize(x.note, 120) : undefined,
    })
  }
  return out.slice(-LOG_MAX)
}

// --- Layout -----------------------------------------------------------------

// Terminal cells a string takes: East Asian wide and fullwidth code points
// (CJK, kana, hangul, fullwidth forms), emoji and the symbol/dingbat blocks
// terminals often draw double (★ ✅ ☀ included) take two; variation selectors
// and the zero-width joiner take none; the rest one. Deliberately generous:
// a name cut one cell short beats a row that wraps.
export function cellWidth(text: string): number {
  let w = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    if (c === 0xfe0f || c === 0xfe0e || c === 0x200d) continue
    w += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2600 && c <= 0x27bf) || (c >= 0x2b00 && c <= 0x2bff) ||
      (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f000 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd) ? 2 : 1
  }
  return w
}

// Cut `text` to at most `cells` cells, ending in an ellipsis when cut.
export function fitCells(text: string, cells: number): string {
  if (cells <= 0) return ''
  if (cellWidth(text) <= cells) return text
  if (cells === 1) return '…'
  let out = ''
  let w = 0
  for (const ch of text) {
    const cw = cellWidth(ch)
    if (w + cw > cells - 1) break
    out += ch
    w += cw
  }
  return `${out}…`
}

export type Tone = 'running' | 'waiting' | 'error'
export type Row = { id: string; name: string; percentText: string; leftText: string; tone: Tone }

export const WAITING_LABEL: Record<Waiting, string> = { decision: '等待裁定', permission: '等待授權' }
export const ERROR_LABEL: Record<ErrorKind, string> = { api: 'API 錯誤', refusal: '模型拒答' }
export type Layout = { rows: Row[]; more: number }

// The band's rows for the running tasks: `self` first, at most MAX_ROWS,
// each name cut so name + percent + minutes fit in `columns` cells (one
// space between parts), the rest counted in `more`.
// Below this many cells left for the name the minutes go first, then the
// project prefix, and only then is the task name cut.
const NAME_MIN_WITH_MINUTES = 30
const NAME_MIN_WITH_PROJECT = 24
const NAME_MIN_WITH_LABEL = 12

export function layoutRows(shown: readonly SessionRecord[], selfId: string, columns: number, now: number): Layout {
  const rows: Row[] = []
  for (const r of shown.slice(0, MAX_ROWS)) {
    const tone: Tone = r.state === 'error' ? 'error' : r.waiting !== undefined ? 'waiting' : 'running'
    const percent = shownPercent(r)
    const hasTodo = r.todoTotal !== undefined && r.todoTotal >= 2
    const percentText = tone === 'error' ? '錯誤' : percent !== undefined && (percent > 0 || hasTodo) ? `${percent}%` : '估算中'
    // The label slot: minutes left while running; what is waited on; why it failed.
    let leftText = ''
    if (tone === 'error') leftText = ERROR_LABEL[r.error ?? 'api']
    else if (tone === 'waiting') leftText = WAITING_LABEL[r.waiting ?? 'decision']
    else {
      const left = remainingMinutes(r, now)
      leftText = left !== undefined ? `剩約 ${left} 分` : ''
    }
    const room = (withLeft: string) => columns - (cellWidth(percentText) + 1 + (withLeft ? cellWidth(withLeft) + 1 : 0))
    // Minutes are the first thing dropped; a waiting or error label only in a very narrow band.
    const labelMin = tone === 'running' ? NAME_MIN_WITH_MINUTES : NAME_MIN_WITH_LABEL
    if (leftText && room(leftText) < labelMin) leftText = ''
    const star = r.id === selfId ? '★' : ''
    let full = `${star}${r.project ? `${r.project}｜` : ''}${r.task}`
    if (r.project && room(leftText) < NAME_MIN_WITH_PROJECT) full = `${star}${r.task}`
    const name = fitCells(full, Math.max(4, room(leftText)))
    rows.push({ id: r.id, name, percentText, leftText, tone })
  }
  return { rows, more: Math.max(0, shown.length - rows.length) }
}

function base(path: unknown): string {
  return typeof path === 'string' ? (path.split(/[\\/]/).pop() ?? path) : ''
}

// A short label for what the agent is doing, from a tool call's input.
export function activityOf(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return `編輯 ${base(input.file_path ?? input.notebook_path)}`
    case 'Read':
      return `讀取 ${base(input.file_path)}`
    case 'Bash':
      return `執行 ${sanitize(String(input.description ?? input.command ?? ''), 30)}`
    case 'Grep':
    case 'Glob':
      return '搜尋檔案'
    case 'WebFetch':
    case 'WebSearch':
      return '查詢網路'
    case 'Agent':
      return '交辦子代理'
    case 'AskUserQuestion':
      return '等你回覆選項'
    default:
      return tool.startsWith('mcp__') ? `使用 ${tool.split('__')[1] ?? '工具'}` : tool
  }
}
