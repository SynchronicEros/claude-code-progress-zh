// Integration tests through the engine's test kit: the real register.tsx
// driven by session.start / prompt.submit / turn.start / tool.call /
// turn.complete, with a virtual folder standing for the shared state
// directory. Adapted from the adversarial review of 0.6.0 (20261007).
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

// The test environment has timers; the lib the mod compiles against does not name them.
declare function setTimeout(fn: (...args: never[]) => void, ms: number): unknown

import { cellWidth, layoutRows, needsEstimate, type SessionRecord } from '../hooks/logic.ts'

// Bottom hooks standing for the engine.
const BELOW = { type: 'Box', props: {}, children: [] } as unknown as RenderElement

type ForkAnswer = { isAnswered: false; reason: 'nothing-to-fork' } | { isAnswered: false; reason: 'api-error' | 'empty-reply' | 'aborted'; status?: number | null; error?: string; usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number } } | { isAnswered: true; text: string; usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number } }

// A virtual folder standing for ~/.claude/claude-mods-data/progress (fresh per test).
const HOME = '/adv'
const DIR = `${HOME}/.claude/claude-mods-data/progress`
type VFS = Map<string, string>

export function seed(vfs: VFS, now: number) {
  const put = (r: Record<string, unknown>) => vfs.set(`${DIR}/${String(r.id)}.json`, JSON.stringify(r))
  put({ id: 'b', project: 'claude-mods', task: '短任務', state: 'running', startedAt: now - 4 * 60_000, updatedAt: now, steps: 3, estPercent: 50 })
  put({ id: 'c', project: 'x', task: 'no estimate yet', state: 'running', startedAt: now - 4 * 60_000, updatedAt: now, steps: 3 })
  put({ id: 'd', project: 'very-long-project-name-here', task: '第四個任務：把 courses/ 底下的簡報全部重新建置並檢查殘留的講者備註', state: 'running', startedAt: now - 4 * 60_000, updatedAt: now, steps: 3, estPercent: 12 })
  put({ id: 'e', project: 'x', task: 'fifth ✅ 帶表情符號的任務名稱 ☀️ 測試寬度', state: 'running', startedAt: now - 4 * 60_000, updatedAt: now, steps: 3, todoDone: 3, todoTotal: 7 })
  vfs.set(`${DIR}/broken.json`, '{not json')
  vfs.set(`${DIR}/nofields.json`, JSON.stringify({ id: 'nofields' }))
  vfs.set(`${DIR}/_cleared.json`, JSON.stringify({ at: now }))
}

// Hooks registered by an earlier test stay active for the whole file, so the
// hooks are registered once and read a store each test resets.
const store: { vfs: VFS; fork: () => ForkAnswer | Promise<ForkAnswer>; forks: number[]; registered: boolean; noFolder: boolean; hold: Map<string, Promise<void>>; waits: string[]; askInCall: Set<string>; raise?: (tool: string) => Promise<unknown> } = {
  vfs: new Map(), fork: () => ({ isAnswered: false, reason: 'nothing-to-fork' }), forks: [], registered: false, noFolder: false, hold: new Map(), waits: [], askInCall: new Set(),
}

function bottoms(on: On, fork: () => ForkAnswer | Promise<ForkAnswer>, withSeed = false) {
  store.noFolder = false
  store.hold = new Map()
  store.waits = []
  store.askInCall = new Set()
  store.raise = undefined
  store.vfs = new Map()
  store.fork = fork
  store.forks = []
  if (withSeed) seed(store.vfs, Date.now())
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('tool.call', async (_$, e) => {
    // Core opens the permission dialog inside the call for the tools the test names.
    if (store.askInCall.has(e.tool) && store.raise !== undefined) await store.raise(e.tool)
    return { result: 'ok' }
  })
  on('turn.complete', async () => ({ text: '' }))
  on('ui.render', { component: 'AbovePrompt' }, async () => BELOW)
  on('model.fork', async () => {
    store.forks.push(Date.now())
    return { value: await store.fork() } as never
  })
  on('session.id', async () => ({ value: 'self-test' }))
  on('session.cwd', async () => ({ value: '/tmp/adv/專案甲' }))
  on('env.get', async (_$, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.invalidate', async () => ({ value: undefined }))
  on('clock.every', async () => ({ value: undefined }))
  on('fs.write', async (_$, e) => {
    store.vfs.set(e.path, e.text)
    if (e.path === SELF) store.waits.push(String((JSON.parse(e.text) as { waiting?: string }).waiting ?? 'none'))
    return { value: undefined }
  })
  on('fs.read', async (_$, e) => {
    const t = store.vfs.get(e.path)
    if (t === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: t }
  })
  on('fs.list', async (_$, e) => {
    if (store.noFolder) throw new Error('ENOENT folder')
    const out: { name: string; kind: 'file'; size: number; mtimeMs: number; isLink: false }[] = []
    for (const [k, v] of store.vfs) if (k.startsWith(`${e.path}/`)) out.push({ name: k.slice(e.path.length + 1), kind: 'file', size: v.length, mtimeMs: 0, isLink: false })
    return { value: out }
  })
  return store
}

const SELF = `${DIR}/self-test.json`
const ownFile = () => JSON.parse(store.vfs.get(SELF) ?? 'null') as Record<string, unknown> | null
const USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

const PROPS = (bodyColumns: number) => ({
  hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns,
  scroll: { offset: 0, bodyRows: 9 }, view: {},
})

const ok = (percent: number): ForkAnswer => ({
  isAnswered: true, text: `{"percent_done": ${percent}}`,
  usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
})

async function start($: Engine, text: string, turnId = 't1') {
  await $.session.start({ cwd: '/tmp/adv/專案甲', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text, turnId })
}

// The first string inside an element (a row part is Box > Text > string).
function firstString(n: unknown): string {
  if (typeof n === 'string') return n
  if (typeof n !== 'object' || n === null) return ''
  for (const c of (n as { children?: unknown[] }).children ?? []) {
    const s = firstString(c)
    if (s !== '') return s
  }
  return ''
}

function rowsOf(tree: RenderElement): { names: string[]; texts: string[] } {
  const t = tree as unknown as { children?: unknown[] }
  const names: string[] = []
  const texts: string[] = []
  const walk = (n: unknown) => {
    if (typeof n === 'string') { texts.push(n); return }
    if (typeof n !== 'object' || n === null) return
    const el = n as { type?: string; props?: Record<string, unknown>; children?: unknown[] }
    if (el.type === 'Box' && el.props?.flexDirection === 'row') names.push(firstString(el.children?.[0]))
    for (const c of el.children ?? []) walk(c)
  }
  walk(t)
  return { names, texts }
}

// ---------------------------------------------------------------------------
test('smoke: a running task draws one starred row on both surfaces', async ($, on) => {
  bottoms(on, () => ({ isAnswered: false, reason: 'nothing-to-fork' }))
  await start($, '整理 notes 目錄並寫摘要')
  await $.tool.call({ tool: 'Read', file_path: '/x' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'progress', surface, component: 'AbovePrompt', props: PROPS(90) })
    const tree = await ui.drawn()
    const { names } = rowsOf(tree)
    expect(names.length).toBe(1)
    expect(names[0]?.startsWith('★')).toBe(true)
    expect((await ui.find({ type: 'Text', text: '估算中' }))).toBeDefined()
    await ui.unmount()
  }
})

// A subagent's turn.complete carries agentId and must leave the main task running.
test('subagent turn.complete does not close the main task', async ($, on) => {
  bottoms(on, () => ({ isAnswered: false, reason: 'nothing-to-fork' }))
  await start($, '交辦子代理去查資料')
  await $.tool.call({ tool: 'Read', file_path: '/x' })
  await $.turn.complete({ reason: 'answer', answer: 'sub done', durationMs: 5, isAborted: false, turnId: 't-sub', agentId: 'agent-1' })
  const ui = await $.ui.mount({ plugin: 'progress', surface: 'desktop', component: 'AbovePrompt', props: PROPS(90) })
  const { names } = rowsOf(await ui.drawn())
  // The main task is still running: the row must still be there.
  expect(names.length).toBe(1)
  await ui.unmount()
})

// A prompt queued mid-turn (turnId set) waits; it becomes the task when its own turn starts.
test('a prompt queued mid-turn does not replace the running task and starts with its turn', async ($, on) => {
  bottoms(on, () => ({ isAnswered: false, reason: 'nothing-to-fork' }))
  await start($, '第一個任務')
  await $.tool.call({ tool: 'Read', file_path: '/x' })
  await $.prompt.submit({ text: '第二個任務（排隊中）', wait: true, turnId: 't1', origin: { kind: 'composer' } })
  let ui = await $.ui.mount({ plugin: 'progress', surface: 'desktop', component: 'AbovePrompt', props: PROPS(90) })
  let { names } = rowsOf(await ui.drawn())
  expect(names[0]?.includes('第一個任務')).toBe(true)
  await ui.unmount()
  // Turn 1 ends: the band empties until turn 2 starts.
  await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 5, isAborted: false, turnId: 't1' })
  ui = await $.ui.mount({ plugin: 'progress', surface: 'desktop', component: 'AbovePrompt', props: PROPS(90) })
  expect(rowsOf(await ui.drawn()).names.length).toBe(0)
  await ui.unmount()
  await $.turn.start({ text: '第二個任務（排隊中）', turnId: 't2' })
  await $.tool.call({ tool: 'Read', file_path: '/y' })
  ui = await $.ui.mount({ plugin: 'progress', surface: 'desktop', component: 'AbovePrompt', props: PROPS(90) })
  names = rowsOf(await ui.drawn()).names
  expect(names.length).toBe(1)
  expect(names[0]?.includes('第二個任務')).toBe(true)
  // A turn.complete for the old turn id changes nothing.
  await $.turn.complete({ reason: 'answer', answer: 'stale', durationMs: 5, isAborted: false, turnId: 't1' })
  expect(ownFile()?.state).toBe('running')
  await ui.unmount()
})

// nothing-to-fork (a new session's first reply not out yet) is no estimate: the next step retries.
test('nothing-to-fork at step 1 is retried at step 2 and logged', async ($, on) => {
  let n = 0
  const { forks } = bottoms(on, () => (n++ === 0 ? { isAnswered: false, reason: 'nothing-to-fork' } : ok(40)))
  await start($, '新 session 第一個任務')
  await $.tool.call({ tool: 'Read', file_path: '/1' })
  expect(forks.length).toBe(1)
  let ui = await $.ui.mount({ plugin: 'progress', surface: 'terminal', component: 'AbovePrompt', props: PROPS(90) })
  expect(await ui.find({ type: 'Text', text: '估算中' })).toBeDefined()
  await ui.unmount()
  await $.tool.call({ tool: 'Read', file_path: '/2' })
  expect(forks.length).toBe(2)
  ui = await $.ui.mount({ plugin: 'progress', surface: 'terminal', component: 'AbovePrompt', props: PROPS(90) })
  expect(await ui.find({ type: 'Text', text: '40%' })).toBeDefined()
  await ui.unmount()
  const est = (ownFile()?.estimates ?? []) as { outcome: string }[]
  expect(est.map(e => e.outcome).join(',')).toBe('nothing-to-fork,ok')
})

// The time-based re-estimate needs at least one new step (no fork while waiting on a dialog).
test('time-based re-estimate needs a new step', async () => {
  const r: SessionRecord = { id: 'a', project: 'p', task: 't', state: 'running', startedAt: 0, updatedAt: 0, steps: 1, estAtSteps: 1, estAtTime: 0 }
  expect(needsEstimate(r, 60_000)).toBe(false)
  expect(needsEstimate(r, 120_000)).toBe(false)
  expect(needsEstimate({ ...r, steps: 2 }, 60_000)).toBe(true)
  expect(needsEstimate({ ...r, steps: 2 }, 30_000)).toBe(false)
})

// Check 3 / P8: TaskCreate + TaskUpdate drive the percent.
test('TaskCreate/TaskUpdate counts give the percent', async ($, on) => {
  bottoms(on, () => ({ isAnswered: false, reason: 'nothing-to-fork' }))
  await start($, '待辦清單任務')
  await $.tool.call({ tool: 'TaskCreate', subject: 'a', description: 'a' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'b', description: 'b' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  const ui = await $.ui.mount({ plugin: 'progress', surface: 'desktop', component: 'AbovePrompt', props: PROPS(90) })
  expect(await ui.find({ type: 'Text', text: '50%' })).toBeDefined()
  await ui.unmount()
})

// Five running records in the folder (4 pre-written + self). 77 = the band width
// measured in the Desktop Code tab on a 13-inch MacBook Air (20261007).
for (const surface of ['terminal', 'desktop'] as const) {
  for (const columns of [60, 77, 90, 120]) {
    test(`layout ${surface} ${columns}: at most 3 rows, self first, widths fit`, async ($, on) => {
      bottoms(on, () => ok(33), true)
      await start($, '逐一閱讀 notes/ 底下每個檔案，各寫兩句摘要後彙整成一張表回覆我，只讀不改任何檔案')
      await $.tool.call({ tool: 'Read', file_path: '/1' })
      const ui = await $.ui.mount({ plugin: 'progress', surface, component: 'AbovePrompt', props: PROPS(columns) })
      await $.tool.call({ tool: 'Read', file_path: '/2' })
      await ui.redraw()
      const tree = await ui.drawn()
      const { names } = rowsOf(tree)
      expect(names.length <= 3).toBe(true)
      expect(names[0]?.startsWith('★')).toBe(true)
      const more = await ui.find({ type: 'Text', text: /另 \d+ 個執行中/ })
      // 4 others + self = 5 running → 3 rows + "另 2 個執行中"
      expect(more?.text).toBe('另 2 個執行中')
      // Width of each row as drawn.
      const rows = (tree as unknown as { children: unknown[] }).children
        .filter(c => typeof c === 'object' && c !== null && (c as { props?: { flexDirection?: string } }).props?.flexDirection === 'row') as { children: unknown[] }[]
      for (const row of rows) {
        const parts = row.children.map(c => firstString(c)).filter(p => p !== '')
        const width = parts.reduce((w, p) => w + cellWidth(p), 0) + (parts.length - 1)
        expect(width <= columns).toBe(true)
        // The percent part is always there.
        expect(parts.length >= 2).toBe(true)
      }
      await ui.unmount()
    })
  }
}

// Symbols terminals often draw double are counted as two cells; … stays one.
test('symbol and emoji glyphs (★ ✅ ☀️) count two cells, … one', async () => {
  expect(cellWidth('★')).toBe(2)
  expect(cellWidth('…')).toBe(1)
  expect(cellWidth('✅')).toBe(2)
  expect(cellWidth('☀️')).toBe(2)
  expect(cellWidth('🚀')).toBe(2)
})

// Narrow bands: minutes go first, then the project prefix; from 12 cells up the row fits.
test('narrow band: rows fit from 12 cells up, dropping minutes then the project prefix', async () => {
  const r: SessionRecord = { id: 'a', project: 'my-project', task: '很長的任務名稱一二三四五', state: 'running', startedAt: 0, updatedAt: 0, estPercent: 95 }
  const now = 100 * 60_000
  for (const columns of [12, 16, 19, 20, 24, 40, 60]) {
    const { rows } = layoutRows([r], 'a', columns, now)
    const row = rows[0]!
    const width = cellWidth(row.name) + 1 + cellWidth(row.percentText) + (row.leftText ? 1 + cellWidth(row.leftText) : 0)
    expect(width <= columns).toBe(true)
  }
  // 40 cells: minutes dropped, project kept; 24 cells: project dropped too.
  expect(layoutRows([r], 'a', 40, now).rows[0]?.leftText).toBe('')
  expect(layoutRows([r], 'a', 40, now).rows[0]?.name.includes('｜')).toBe(true)
  expect(layoutRows([r], 'a', 24, now).rows[0]?.name.includes('｜')).toBe(false)
  const wide = layoutRows([r], 'a', 60, now).rows[0]!
  expect(wide.leftText).toBe('剩約 5 分')
  expect(wide.name.startsWith('★my-project｜')).toBe(true)
})

// Check 3: a lower later estimate never lowers the shown percent; 100 caps at 95.
test('percent only rises and caps at 95 while running', async ($, on) => {
  const answers = [60, 20, 100]
  let i = 0
  bottoms(on, () => ok(answers[Math.min(i++, answers.length - 1)]!))
  await start($, '只升不降')
  await $.tool.call({ tool: 'Read', file_path: '/1' })
  let ui = await $.ui.mount({ plugin: 'progress', surface: 'terminal', component: 'AbovePrompt', props: PROPS(90) })
  expect(await ui.find({ type: 'Text', text: '60%' })).toBeDefined()
  await ui.unmount()
  for (const f of ['/2', '/3', '/4']) await $.tool.call({ tool: 'Read', file_path: f })
  ui = await $.ui.mount({ plugin: 'progress', surface: 'terminal', component: 'AbovePrompt', props: PROPS(90) })
  expect(await ui.find({ type: 'Text', text: '60%' })).toBeDefined()
  await ui.unmount()
  for (const f of ['/5', '/6', '/7']) await $.tool.call({ tool: 'Read', file_path: f })
  ui = await $.ui.mount({ plugin: 'progress', surface: 'terminal', component: 'AbovePrompt', props: PROPS(90) })
  expect(await ui.find({ type: 'Text', text: '95%' })).toBeDefined()
  await ui.unmount()
})

// Check 4: turn.complete marks done, the band empties.
test('turn.complete on the main loop empties the band', async ($, on) => {
  bottoms(on, () => ({ isAnswered: false, reason: 'nothing-to-fork' }))
  await start($, '會結束的任務')
  await $.tool.call({ tool: 'Read', file_path: '/1' })
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 5, isAborted: false, turnId: 't1' })
  const ui = await $.ui.mount({ plugin: 'progress', surface: 'desktop', component: 'AbovePrompt', props: PROPS(90) })
  const { names } = rowsOf(await ui.drawn())
  expect(names.length).toBe(0)
  await ui.unmount()
})


// Check 5: no folder at all → nothing crashes, the band stays empty.
test('no folder yet: nothing crashes and the band is empty', async ($, on) => {
  bottoms(on, () => ({ isAnswered: false, reason: 'nothing-to-fork' }))
  store.noFolder = true
  await $.session.start({ cwd: '/tmp/adv/專案甲', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'progress', surface: 'desktop', component: 'AbovePrompt', props: PROPS(90) })
  expect(rowsOf(await ui.drawn()).names.length).toBe(0)
  await ui.unmount()
})

// Check 1: non-user origins start no task.
test('plugin / task-notification / peer prompts start no task', async ($, on) => {
  bottoms(on, () => ({ isAnswered: false, reason: 'nothing-to-fork' }))
  await $.session.start({ cwd: '/tmp/adv/專案甲', surface: 'desktop', isInteractive: true })
  for (const kind of ['task-notification', 'peer', 'scheduled-trigger'] as const) {
    await $.prompt.submit({ text: `來源 ${kind}`, wait: false, origin: { kind } })
  }
  await $.prompt.submit({ text: '外掛來源', wait: false, origin: { kind: 'plugin', name: 'other' } as never })
  await $.tool.call({ tool: 'Read', file_path: '/x' })
  const ui = await $.ui.mount({ plugin: 'progress', surface: 'desktop', component: 'AbovePrompt', props: PROPS(90) })
  expect(rowsOf(await ui.drawn()).names.length).toBe(0)
  await ui.unmount()
})

// Check 4: memory empty, file says running → session.start restores, turn.complete closes it.
test('restoreSelf: a running own record is taken back and closed at turn end', async ($, on) => {
  bottoms(on, () => ({ isAnswered: false, reason: 'nothing-to-fork' }))
  const now = Date.now()
  store.vfs.set(SELF, JSON.stringify({ id: 'self-test', project: '專案甲', task: '重載前的任務', state: 'running', startedAt: now - 60_000, updatedAt: now - 1000, steps: 5, estPercent: 40 }))
  await $.session.start({ cwd: '/tmp/adv/專案甲', surface: 'desktop', isInteractive: true })
  let ui = await $.ui.mount({ plugin: 'progress', surface: 'desktop', component: 'AbovePrompt', props: PROPS(90) })
  const { names } = rowsOf(await ui.drawn())
  expect(names[0]?.startsWith('★')).toBe(true)
  expect(names[0]?.includes('重載前的任務')).toBe(true)
  await ui.unmount()
  await $.turn.complete({ reason: 'aborted', answer: '', durationMs: 5, isAborted: true, turnId: 't1' })
  expect(ownFile()?.state).toBe('stopped')
  ui = await $.ui.mount({ plugin: 'progress', surface: 'desktop', component: 'AbovePrompt', props: PROPS(90) })
  expect(rowsOf(await ui.drawn()).names.length).toBe(0)
  await ui.unmount()
})

// Check 6: every fork outcome is classified and logged.
test('fork outcomes: api-error, empty-reply, aborted, parse-fail, thrown error, ok', async ($, on) => {
  const answers: (() => ForkAnswer)[] = [
    () => ({ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE }),
    () => ({ isAnswered: false, reason: 'empty-reply', usage: USAGE }),
    () => ({ isAnswered: false, reason: 'aborted', usage: USAGE }),
    () => ({ isAnswered: true, text: 'I think about 40 percent', usage: USAGE }),
    () => { throw new Error('boom') },
    () => ok(42),
  ]
  let i = 0
  bottoms(on, () => answers[Math.min(i++, answers.length - 1)]!())
  await start($, '各種結果')
  for (let step = 1; step <= 16; step++) await $.tool.call({ tool: 'Read', file_path: `/${step}` })
  const est = (ownFile()?.estimates ?? []) as { outcome: string; note?: string; percent?: number; step: number }[]
  expect(est.map(e => e.outcome).join(',')).toBe('api-error,empty-reply,aborted,parse-fail,error,ok')
  expect(est[0]?.note).toBe('overloaded 529')
  expect(est[5]?.percent).toBe(42)
  expect(ownFile()?.estPercent).toBe(42)
})

// Check 2 + 7: a fork still in flight while steps continue; its answer after the turn ended is `late`.
test('in-flight estimate keeps later steps; an answer after turn end is late and not shown', async ($, on) => {
  let release: ((a: ForkAnswer) => void) | undefined
  const pending = new Promise<ForkAnswer>(r => { release = r })
  let n = 0
  bottoms(on, () => (n++ === 0 ? pending : ok(70)))
  await start($, '競態')
  const p1 = $.tool.call({ tool: 'Read', file_path: '/1' })  // step 1 → fork (pending)
  await p1
  await $.tool.call({ tool: 'Read', file_path: '/2' })
  await $.tool.call({ tool: 'Read', file_path: '/3' })
  await $.tool.call({ tool: 'Read', file_path: '/4' })  // needsEstimate true but isEstimating → no second fork
  expect(store.forks.length).toBe(1)
  await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 5, isAborted: false, turnId: 't1' })
  expect(ownFile()?.state).toBe('done')
  release!(ok(40))
  await new Promise(r => setTimeout(r, 20))
  const own = ownFile()
  const est = (own?.estimates ?? []) as { outcome: string }[]
  expect(est[0]?.outcome).toBe('late')
  expect(own?.estPercent).toBe(undefined)
  expect(own?.steps).toBe(4)
  expect(own?.state).toBe('done')
})

// Check 7: a fork answer landing between steps keeps the steps counted meanwhile.
test('estimate answer merges with steps taken while it ran', async ($, on) => {
  let release: ((a: ForkAnswer) => void) | undefined
  const pending = new Promise<ForkAnswer>(r => { release = r })
  let n = 0
  bottoms(on, () => (n++ === 0 ? pending : ok(70)))
  await start($, '合併')
  await $.tool.call({ tool: 'Read', file_path: '/1' })
  await $.tool.call({ tool: 'Read', file_path: '/2' })
  release!(ok(40))
  await new Promise(r => setTimeout(r, 20))
  const own = ownFile()
  expect(own?.steps).toBe(2)
  expect(own?.estPercent).toBe(40)
})

// --- Waiting (yellow) and error (red) rows ------------------------------------

test('an AskUserQuestion call writes waiting=decision for its duration, then clears it', async ($, on) => {
  bottoms(on, () => ({ isAnswered: false, reason: 'nothing-to-fork' }))
  await start($, '要問你的任務')
  await $.tool.call({ tool: 'Read', file_path: '/1' })
  store.waits = []
  await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: 'q?', header: 'h', options: [{ label: 'a', description: 'a' }, { label: 'b', description: 'b' }], multiSelect: false }] })
  // Written as 'decision' while the dialog was open, back to none once it closed.
  expect(store.waits[0]).toBe('decision')
  expect(store.waits[store.waits.length - 1]).toBe('none')
  expect(store.waits.slice(0, -1).every(w => w === 'decision')).toBe(true)
  expect(ownFile()?.waiting).toBe(undefined)
})

// A permission dialog shown to the person (classic PermissionRequest) marks the
// task as waiting for permission; the dialog's tool resolving clears it. An
// `ask` the engine settles without a dialog (auto mode) never fires this event.
test('a permission dialog marks waiting for permission until that tool call resolves', async ($, on) => {
  bottoms(on, () => ({ isAnswered: false, reason: 'nothing-to-fork' }))
  on('classic.PermissionRequest', async () => ({}))
  store.askInCall.add('Write')
  store.raise = tool => $.classic.PermissionRequest({ tool_name: tool, tool_input: {} })
  await start($, '要授權的任務')
  await $.tool.call({ tool: 'Read', file_path: '/1' })
  store.waits = []
  await $.tool.call({ tool: 'Write', file_path: '/x', content: 'y' })
  // Written as 'permission' while the dialog was open inside the call, none once it resolved.
  expect(store.waits[0]).toBe('permission')
  expect(store.waits[store.waits.length - 1]).toBe('none')
  expect(ownFile()?.waiting).toBe(undefined)
  // A tool that opens no dialog leaves no mark.
  store.waits = []
  await $.tool.call({ tool: 'Read', file_path: '/2' })
  expect(store.waits.includes('permission')).toBe(false)
})

test('an ask verdict without a dialog (auto mode) does not mark waiting', async ($, on) => {
  bottoms(on, () => ({ isAnswered: false, reason: 'nothing-to-fork' }))
  on('tool.check', async () => ({ decision: 'ask' as const }))
  await start($, '自動模式的任務')
  await $.tool.call({ tool: 'Read', file_path: '/1' })
  const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })
  expect(verdict.decision).toBe('ask')
  expect(ownFile()?.waiting).toBe(undefined)
})

test('waiting and error records from other sessions draw yellow and red labels', async ($, on) => {
  bottoms(on, () => ({ isAnswered: false, reason: 'nothing-to-fork' }))
  const now = Date.now()
  const put = (r: Record<string, unknown>) => store.vfs.set(`${DIR}/${String(r.id)}.json`, JSON.stringify(r))
  put({ id: 'w', project: 'p', task: '等你選', state: 'running', startedAt: now - 60_000, updatedAt: now, steps: 2, estPercent: 40, waiting: 'decision' })
  put({ id: 'q', project: 'p', task: '等權限', state: 'running', startedAt: now - 60_000, updatedAt: now, steps: 2, waiting: 'permission' })
  put({ id: 'e', project: 'p', task: '壞了', state: 'error', error: 'api', startedAt: now - 3 * 60 * 60_000, updatedAt: now - 2 * 60 * 60_000, steps: 2 })
  await $.session.start({ cwd: '/tmp/adv/專案甲', surface: 'desktop', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'progress', surface, component: 'AbovePrompt', props: PROPS(90) })
    await ui.redraw()
    expect(rowsOf(await ui.drawn()).names.length).toBe(3)
    expect((await ui.find({ type: 'Text', text: '等待裁定' }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: '等待授權' }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: '錯誤' }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: 'API 錯誤' }))).toBeDefined()
    await ui.unmount()
  }
})

test('a turn ending on an error leaves a red error row until the next task; an interrupt hides the row', async ($, on) => {
  bottoms(on, () => ({ isAnswered: false, reason: 'nothing-to-fork' }))
  await start($, '會出錯的任務')
  await $.tool.call({ tool: 'Read', file_path: '/1' })
  await $.turn.complete({ reason: 'error', answer: '', durationMs: 5, isAborted: false, turnId: 't1' })
  expect(ownFile()?.state).toBe('error')
  let ui = await $.ui.mount({ plugin: 'progress', surface: 'desktop', component: 'AbovePrompt', props: PROPS(90) })
  expect(rowsOf(await ui.drawn()).names.length).toBe(1)
  expect(await ui.find({ type: 'Text', text: '錯誤' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'API 錯誤' })).toBeDefined()
  await ui.unmount()
  // The next task replaces the error row.
  await $.prompt.submit({ text: '下一個任務', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: '下一個任務', turnId: 't2' })
  await $.tool.call({ tool: 'Read', file_path: '/2' })
  ui = await $.ui.mount({ plugin: 'progress', surface: 'desktop', component: 'AbovePrompt', props: PROPS(90) })
  expect(await ui.find({ type: 'Text', text: '錯誤' })).toBe(undefined)
  expect(rowsOf(await ui.drawn()).names[0]?.includes('下一個任務')).toBe(true)
  await ui.unmount()
  // An interrupt by the person is not an error: the row goes away.
  await $.turn.complete({ reason: 'aborted', answer: '', durationMs: 5, isAborted: true, turnId: 't2' })
  expect(ownFile()?.state).toBe('stopped')
  ui = await $.ui.mount({ plugin: 'progress', surface: 'desktop', component: 'AbovePrompt', props: PROPS(90) })
  expect(rowsOf(await ui.drawn()).names.length).toBe(0)
  await ui.unmount()
})

test('a refusal is a red row labelled 模型拒答', async ($, on) => {
  bottoms(on, () => ({ isAnswered: false, reason: 'nothing-to-fork' }))
  await start($, '被拒的任務')
  await $.tool.call({ tool: 'Read', file_path: '/1' })
  await $.turn.complete({ reason: 'refusal', answer: '', durationMs: 5, isAborted: false, turnId: 't1', refusal: { reason: 'policy' } } as never)
  expect(ownFile()?.error).toBe('refusal')
  const ui = await $.ui.mount({ plugin: 'progress', surface: 'desktop', component: 'AbovePrompt', props: PROPS(90) })
  expect(await ui.find({ type: 'Text', text: '模型拒答' })).toBeDefined()
  await ui.unmount()
})
