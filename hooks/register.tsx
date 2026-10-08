/* @jsxRuntime classic */
/* @jsx h */
/* @jsxFrag Fragment */
// progress: a band above the prompt listing the task each Claude Code session
// on this machine is running, as a percent and minutes left. No API reads
// another session, so each session writes its own record to
// ~/.claude/claude-mods-data/progress/<session id>.json (one writer per file,
// nothing clobbered) and every session reads the folder on a timer.
// The percent does not wait on the agent to report: at the agent's first
// step (tool call), then every few steps or every minute, the mod forks the
// session (it shares the prompt cache) and asks what percent of the job is
// done, the final reply counted as work left; the shown percent only rises.
// When the agent keeps a to-do list, its completed share is used instead.

import type { EngineInterface, Register, RenderElement } from 'claude-code'

import {
  activityOf,
  ESTIMATE_PROMPT,
  layoutRows,
  logEstimate,
  needsEstimate,
  parseRecord,
  parsePercent,
  raise,
  sanitize,
  shownRecords,
  todoCounts,
  type EstimateEntry,
  type SessionRecord,
  type Tone,
  type Waiting,
} from './logic.ts'

// Blue while running, yellow while waiting on the person, red on an error.
const TONE_COLOR: Record<Tone, string> = { running: 'cyan', waiting: 'yellow', error: 'red' }

const USER_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'unclassified'])
const REFRESH_MS = 5_000
const WRITE_GAP_MS = 2_000

// Session-local; a reload resets it and the next write restores the file.
let dir = ''
let selfId = ''
let project = ''
let self: SessionRecord | null = null
let lastWrite = 0
let records: SessionRecord[] = []
let isEstimating = false
// The text of a prompt the person sent that has not started its turn yet
// (typed while idle, or queued behind the running turn).
let pendingText: string | null = null
let lastColumns: number | undefined
const completedTasks = new Set<string>()
// Parsed records by file name with the mtime they were read at: a file is
// re-read only when it changed.
const fileCache = new Map<string, { mtimeMs: number; record: SessionRecord | null }>()
// Tools whose permission dialog is open right now (by tool name), and how
// many tool calls are in flight (none left: nothing can be asked).
const pendingAsks = new Set<string>()
let inFlight = 0

async function resolveDir($: EngineInterface): Promise<string> {
  if (dir !== '') return dir
  const home = (await $.env.get('HOME')) ?? ''
  dir = `${home}/.claude/claude-mods-data/progress`
  return dir
}

async function save($: EngineInterface, force: boolean): Promise<void> {
  if (self === null || selfId === '') return
  const now = Date.now()
  if (!force && now - lastWrite < WRITE_GAP_MS) return
  lastWrite = now
  self = { ...self, updatedAt: now }
  try {
    await $.fs.write(`${await resolveDir($)}/${selfId}.json`, JSON.stringify(self))
  } catch (error) {
    $.ui.log(`write failed: ${String(error)}`)
  }
}

async function refresh($: EngineInterface): Promise<void> {
  const now = Date.now()
  if (self?.state === 'running') {
    if (lastColumns !== undefined && self.columns !== lastColumns) self = { ...self, columns: lastColumns }
    await save($, true)
    if (needsEstimate(self, now)) void estimate($)
  }
  const folder = await resolveDir($)
  const found: SessionRecord[] = []
  try {
    for (const entry of await $.fs.list(folder)) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
      const cached = fileCache.get(entry.name)
      let record: SessionRecord | null
      if (cached !== undefined && entry.mtimeMs > 0 && cached.mtimeMs === entry.mtimeMs) record = cached.record
      else {
        record = parseRecord(await $.fs.read(`${folder}/${entry.name}`).catch(() => ''))
        fileCache.set(entry.name, { mtimeMs: entry.mtimeMs, record })
      }
      if (record !== null) found.push(record)
    }
  } catch {
    // No folder yet: nothing has run on this machine.
  }
  // Oldest task first so the rows do not reshuffle as files are listed.
  found.sort((a, b) => a.startedAt - b.startedAt)
  records = found
  $.ui.invalidate('ui.render')
}

// One estimate at a time. Every attempt is logged on the task's record with
// its outcome, so a percent that never rises can be told apart from a fork
// that failed, answered nothing, or answered after the task had ended.
async function estimate($: EngineInterface): Promise<void> {
  if (isEstimating || self === null) return
  isEstimating = true
  const startedAt = self.startedAt
  const sentAt = Date.now()
  const step = self.steps ?? 0
  const before = { estAtSteps: self.estAtSteps, estAtTime: self.estAtTime }
  self = { ...self, estAtSteps: step, estAtTime: sentAt }
  let entry: EstimateEntry = { at: sentAt, ms: 0, step, outcome: 'error' }
  try {
    const reply = await $.model.fork({ prompt: ESTIMATE_PROMPT })
    entry.ms = Date.now() - sentAt
    if (!reply.isAnswered) {
      const r = reply as { reason: string; error?: string; status?: number | null }
      entry = { ...entry, outcome: r.reason, note: r.error !== undefined ? `${r.error} ${r.status ?? ''}`.trim() : undefined }
    } else {
      const percent = parsePercent(reply.text)
      if (percent === undefined) entry = { ...entry, outcome: 'parse-fail', note: sanitize(reply.text, 120) }
      else if (self !== null && self.startedAt === startedAt && self.state === 'running') entry = { ...entry, outcome: 'ok', percent }
      else entry = { ...entry, outcome: 'late', percent }
    }
  } catch (error) {
    entry = { ...entry, ms: Date.now() - sentAt, outcome: 'error', note: sanitize(String(error), 120) }
    $.ui.log(`estimate failed: ${String(error)}`)
  } finally {
    isEstimating = false
  }
  // Log on the same task's record, running or just finished; a newer task
  // has its own record and this answer is dropped.
  if (self !== null && self.startedAt === startedAt) {
    self = { ...self, estimates: logEstimate(self.estimates, entry) }
    // The engine made no request (the session's first reply is not out yet):
    // this was no estimate, so the next step tries again at no cost.
    if (entry.outcome === 'nothing-to-fork') self = { ...self, ...before }
    if (entry.outcome === 'ok' && entry.percent !== undefined) self = { ...self, estPercent: raise(self.estPercent, entry.percent) }
    await save($, true)
    $.ui.invalidate('ui.render')
  }
}

// A reload (or a restart mid-task) empties the module's memory; take this
// session's own record back from its file so the turn's end can close it.
async function restoreSelf($: EngineInterface): Promise<void> {
  if (self !== null || selfId === '') return
  try {
    const own = parseRecord(await $.fs.read(`${await resolveDir($)}/${selfId}.json`))
    if (own !== null && own.state === 'running') self = own
  } catch {
    // No record of this session yet.
  }
}

// Mark or clear what this session's task waits on; written at once so other
// sessions see it.
async function setWaiting($: EngineInterface, waiting: Waiting | undefined): Promise<void> {
  if (self === null || self.state !== 'running' || self.waiting === waiting) return
  self = { ...self, waiting }
  await save($, true)
  $.ui.invalidate('ui.render')
}

async function waitOnDecision<T>($: EngineInterface, agentId: string | undefined, run: () => Promise<T>): Promise<T> {
  if (agentId !== undefined) return run()
  await setWaiting($, 'decision')
  try {
    return await run()
  } finally {
    await setWaiting($, undefined)
  }
}

function selfFirst(list: readonly SessionRecord[]): SessionRecord[] {
  if (self === null) return [...list]
  const own = self
  return [own, ...list.filter(r => r.id !== own.id)]
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    selfId = await $.session.id()
    const cwd = await $.session.cwd()
    project = sanitize(cwd.split(/[\\/]/).pop() ?? cwd, 30)
    await restoreSelf($)
    $.clock.every(REFRESH_MS, () => void refresh($))
    void refresh($)
    return next(e)
  })

  // A prompt the person sent names the next task; it starts when its turn
  // does (a prompt typed over a running turn waits behind it).
  on('prompt.submit', async ($, e, next) => {
    const origin = (e as { origin?: { kind?: string } }).origin?.kind
    if (origin === undefined || USER_ORIGINS.has(origin)) pendingText = e.text
    return next(e)
  })

  // The main loop's turn begins: the pending prompt becomes this session's
  // running task (a subagent's run raises no turn.start).
  on('turn.start', async ($, e, next) => {
    if (pendingText !== null) {
      const now = Date.now()
      completedTasks.clear()
      self = {
        id: selfId, project, task: sanitize(e.text || pendingText, 40) || '（無標題）',
        state: 'running', startedAt: now, updatedAt: now, turnId: e.turnId, steps: 0, columns: lastColumns,
      }
      pendingText = null
      void save($, true)
    }
    return next(e)
  })

  // A question to the person, or a plan awaiting approval: the task waits.
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e, next) => waitOnDecision($, e.agentId, () => next(e)))
  on('tool.call', { tool: 'ExitPlanMode' }, ($, e, next) => waitOnDecision($, e.agentId, () => next(e)))

  // A permission dialog is about to be shown to the person (not an `ask`
  // the auto-mode classifier settles on its own): the task waits until the
  // call of that tool resolves. A subagent's dialog blocks the person too.
  on('classic.PermissionRequest', async ($, e, next) => {
    if (self?.state === 'running') {
      pendingAsks.add(e.tool_name)
      await setWaiting($, 'permission')
    }
    return next(e)
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const counts = todoCounts(e.todos)
    if (e.agentId === undefined && self?.state === 'running' && counts !== undefined) {
      self = { ...self, todoDone: counts.done, todoTotal: counts.total }
    }
    return next(e)
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    if (e.agentId === undefined && self?.state === 'running') {
      self = { ...self, todoTotal: (self.todoTotal ?? 0) + 1, todoDone: self.todoDone ?? 0 }
    }
    return next(e)
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    if (self?.state === 'running' && e.status === 'completed' && !completedTasks.has(e.taskId)) {
      completedTasks.add(e.taskId)
      self = { ...self, todoDone: (self.todoDone ?? 0) + 1 }
    } else if (self?.state === 'running' && e.status === 'deleted') {
      self = { ...self, todoTotal: Math.max(0, (self.todoTotal ?? 1) - 1) }
    }
    return next(e)
  })

  // Every main-loop tool call is one step (a subagent's are its own work);
  // it also names what the agent is doing.
  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined && self?.state === 'running') {
      self = {
        ...self,
        steps: (self.steps ?? 0) + 1,
        activity: activityOf(e.tool, e as unknown as Record<string, unknown>),
      }
      void save($, false)
      if (needsEstimate(self, Date.now())) void estimate($)
    }
    inFlight++
    try {
      return await next(e)
    } finally {
      inFlight--
      pendingAsks.delete(e.tool)
      if (inFlight === 0) pendingAsks.clear()
      if (pendingAsks.size === 0 && self?.waiting === 'permission') await setWaiting($, undefined)
    }
  })

  // Only the main loop's own turn closes the task; a subagent's turn, or a
  // stale one, leaves it running.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    await restoreSelf($)
    if (self !== null && self.state === 'running' && (self.turnId === undefined || self.turnId === e.turnId)) {
      const failed = e.reason === 'error' || e.reason === 'refusal'
      self = {
        ...self,
        state: e.reason === 'answer' ? 'done' : failed ? 'error' : 'stopped',
        error: failed ? (e.reason === 'refusal' ? 'refusal' : 'api') : undefined,
        waiting: undefined,
        activity: undefined,
      }
      pendingAsks.clear()
      await save($, true)
      void refresh($)
    }
    return result
  })

  // At most MAX_ROWS text rows, one per running task (this session first):
  // name, percent, minutes left, each cut to the band's width; the rest fold
  // into one "another N" row. Finished, stopped and silent tasks are not shown.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next): Promise<RenderElement> => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const now = Date.now()
    const columns = e.props.bodyColumns
    lastColumns = columns
    const shown = shownRecords(selfFirst(records), now)
    if (shown.length === 0) return below
    const { rows, more } = layoutRows(shown, selfId, columns, now)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {below}
        {rows.map(r => (
          <Box key={r.id} flexDirection="row" gap={1}>
            <Box flexShrink={1} minWidth={4}><Text wrap="truncate">{r.name}</Text></Box>
            <Box flexShrink={0}><Text bold color={TONE_COLOR[r.tone]}>{r.percentText}</Text></Box>
            {r.leftText !== '' && (
              <Box flexShrink={0}>
                {r.tone === 'running' ? <Text dimColor>{r.leftText}</Text> : <Text color={TONE_COLOR[r.tone]}>{r.leftText}</Text>}
              </Box>
            )}
          </Box>
        ))}
        {more > 0 && <Text key="more" dimColor>另 {more} 個執行中</Text>}
      </Box>
    )
  })
}
