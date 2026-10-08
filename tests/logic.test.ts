import { expect, test } from 'claude-code/testing'

import {
  activityOf, isLost, needsEstimate, parsePercent, parseRecord, raise, remainingMinutes, shownPercent, todoCounts, visible,
  type SessionRecord,
} from '../hooks/logic.ts'

const base: SessionRecord = { id: 'a', project: 'p', task: 't', state: 'running', startedAt: 0, updatedAt: 0 }

test('percent is the fork estimate, capped at 95 while running', async () => {
  expect(shownPercent({ ...base, estPercent: 30 })).toBe(30)
  expect(shownPercent({ ...base, estPercent: 100 })).toBe(95)
  expect(shownPercent({ ...base, steps: 3 })).toBe(undefined)
})

test('to-do list wins over the estimate when it has two or more items', async () => {
  expect(shownPercent({ ...base, estPercent: 30, todoDone: 1, todoTotal: 4 })).toBe(25)
  expect(shownPercent({ ...base, estPercent: 30, todoDone: 1, todoTotal: 1 })).toBe(30)
  expect(todoCounts([{ status: 'completed' }, { status: 'pending' }])?.done).toBe(1)
})

test('minutes left follow the pace so far', async () => {
  expect(remainingMinutes({ ...base, estPercent: 25 }, 4 * 60_000)).toBe(12)
  expect(remainingMinutes({ ...base, state: 'done', estPercent: 25 }, 4 * 60_000)).toBe(undefined)
})

test('estimates at the first step, every three steps or every minute', async () => {
  expect(needsEstimate({ ...base, steps: 0 }, 0)).toBe(false)
  expect(needsEstimate({ ...base, steps: 1 }, 0)).toBe(true)
  expect(needsEstimate({ ...base, steps: 3, estAtSteps: 1, estAtTime: 0 }, 30_000)).toBe(false)
  expect(needsEstimate({ ...base, steps: 4, estAtSteps: 1, estAtTime: 0 }, 30_000)).toBe(true)
  expect(needsEstimate({ ...base, steps: 2, estAtSteps: 1, estAtTime: 0 }, 61_000)).toBe(true)
})

test('estimate replies parse, and the percent only rises', async () => {
  expect(parsePercent('{"percent_done": 40}')).toBe(40)
  expect(parsePercent('ok {"percent_done": 140} end')).toBe(100)
  expect(parsePercent('no idea')).toBe(undefined)
  expect(raise(60, 40)).toBe(60)
  expect(raise(undefined, 40)).toBe(40)
})

test('forgotten and stale records', async () => {
  const now = 20 * 60 * 60_000
  const rows = visible([
    { ...base, id: 'old', updatedAt: 0 },
    { ...base, id: 'run1', updatedAt: now - 1 },
  ], now)
  expect(rows.map(r => r.id).join(',')).toBe('run1')
  expect(isLost({ ...base, updatedAt: now - 10 * 60_000 }, now)).toBe(true)
  // Four missed 5-second heartbeats: lost; two: still shown.
  expect(isLost({ ...base, updatedAt: now - 25_000 }, now)).toBe(true)
  expect(isLost({ ...base, updatedAt: now - 10_000 }, now)).toBe(false)
  // A killed session's record vanishes from the rows; an error row does not age out this way.
  expect(shownRecords([{ ...base, updatedAt: now - 25_000 }, { ...base, id: 'e', state: 'error', updatedAt: now - 25_000 }], now).map(r => r.id).join(',')).toBe('e')
})

test('records parse defensively', async () => {
  expect(parseRecord('nope')).toBe(null)
  const r = parseRecord(JSON.stringify({ ...base, steps: 4, estPercent: -2, task: 'x\x1b[31my' }))
  expect(r?.steps).toBe(4)
  expect(r?.estPercent).toBe(undefined)
  expect(r?.task).toBe('xy')
})

test('activity labels name the file or command', async () => {
  expect(activityOf('Read', { file_path: '/a/b/notes.md' })).toBe('讀取 notes.md')
  expect(activityOf('Bash', { command: 'npm test', description: '跑測試' })).toBe('執行 跑測試')
})

import { cellWidth, fitCells, layoutRows, logEstimate, LOG_MAX, MAX_ROWS } from '../hooks/logic.ts'

test('estimate log keeps every attempt, newest last, capped', async () => {
  let log = logEstimate(undefined, { at: 1, ms: 10, step: 1, outcome: 'nothing-to-fork' })
  log = logEstimate(log, { at: 2, ms: 20, step: 4, outcome: 'ok', percent: 30 })
  expect(log.length).toBe(2)
  expect(log[1]?.outcome).toBe('ok')
  for (let i = 0; i < LOG_MAX + 5; i++) log = logEstimate(log, { at: i, ms: 1, step: i, outcome: 'ok', percent: i })
  expect(log.length).toBe(LOG_MAX)
  const r = parseRecord(JSON.stringify({ ...base, estimates: log, columns: 96 }))
  expect(r?.estimates?.length).toBe(LOG_MAX)
  expect(r?.columns).toBe(96)
})

test('cell width counts CJK as two cells and cuts with an ellipsis', async () => {
  expect(cellWidth('ab')).toBe(2)
  expect(cellWidth('中文')).toBe(4)
  expect(cellWidth('★a｜')).toBe(5)
  expect(fitCells('中文字串', 5)).toBe('中文…')
  expect(fitCells('abc', 5)).toBe('abc')
  expect(cellWidth(fitCells('很長的任務名稱一二三四五', 9))).toBe(9)
})

test('rows fit the band width, self first, at most MAX_ROWS, the rest counted', async () => {
  const now = 4 * 60_000
  const list: SessionRecord[] = [
    { ...base, id: 'me', project: 'my-project', task: '逐一閱讀 notes/ 底下每個檔案，各寫兩句摘要後彙整成一張表', estPercent: 25 },
    { ...base, id: 'b', project: 'claude-mods', task: 'short', estPercent: 50 },
    { ...base, id: 'c', project: 'x', task: 'no estimate yet' },
    { ...base, id: 'd', project: 'x', task: 'fourth' },
    { ...base, id: 'e', project: 'x', task: 'fifth' },
  ]
  const { rows, more } = layoutRows(list, 'me', 80, now)
  expect(rows.length).toBe(MAX_ROWS)
  expect(more).toBe(2)
  expect(rows[0]?.name.startsWith('★my-project｜')).toBe(true)
  for (const r of rows) {
    const width = cellWidth(r.name) + 1 + cellWidth(r.percentText) + (r.leftText ? 1 + cellWidth(r.leftText) : 0)
    expect(width <= 80).toBe(true)
  }
  expect(rows[2]?.percentText).toBe('估算中')
  expect(rows[2]?.leftText).toBe('')
  // A narrow band drops the minutes, then the project prefix, before cutting the name.
  const narrow = layoutRows(list.slice(0, 1), 'me', 20, now).rows[0]!
  expect(narrow.leftText).toBe('')
  expect(narrow.name.includes('｜')).toBe(false)
  expect(narrow.name.startsWith('★')).toBe(true)
  expect(cellWidth(narrow.name) + 1 + cellWidth(narrow.percentText) <= 20).toBe(true)
})

import { shownRecords } from '../hooks/logic.ts'

test('waiting and error rows: tone, label, and which records show', async () => {
  const now = 4 * 60_000
  const list: SessionRecord[] = [
    { ...base, id: 'w', project: 'p', task: '等你選', estPercent: 40, waiting: 'decision', updatedAt: now },
    { ...base, id: 'q', project: 'p', task: '等權限', estPercent: 40, waiting: 'permission', updatedAt: now },
    { ...base, id: 'e', project: 'p', task: '壞了', state: 'error', error: 'api', estPercent: 70, updatedAt: now - 2 * 60 * 60_000 },
    { ...base, id: 's', project: 'p', task: '被中斷', state: 'stopped', updatedAt: now },
    { ...base, id: 'l', project: 'p', task: '失聯', updatedAt: now - 10 * 60_000 },
  ]
  const shown = shownRecords(list, now)
  // Error rows stay (even hours later); interrupted and lost ones do not.
  expect(shown.map(r => r.id).join(',')).toBe('w,q,e')
  const { rows } = layoutRows(shown, 'w', 80, now)
  expect(rows[0]?.tone).toBe('waiting')
  expect(rows[0]?.percentText).toBe('40%')
  expect(rows[0]?.leftText).toBe('等待裁定')
  expect(rows[1]?.leftText).toBe('等待授權')
  expect(rows[2]?.tone).toBe('error')
  expect(rows[2]?.percentText).toBe('錯誤')
  expect(rows[2]?.leftText).toBe('API 錯誤')
  expect(layoutRows([{ ...list[2]!, error: 'refusal' }], 'x', 80, now).rows[0]?.leftText).toBe('模型拒答')
  // A waiting label survives a narrow band where minutes would be dropped.
  expect(layoutRows([list[0]!], 'w', 30, now).rows[0]?.leftText).toBe('等待裁定')
  expect(layoutRows([{ ...base, estPercent: 40 }], 'x', 30, now).rows[0]?.leftText).toBe('')
})
