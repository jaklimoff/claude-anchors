import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register, SessionMessage } from 'claude-code'

import type { CompactionRecord, StoredAnchor } from '../types'
import { anchorsOf, countByKind, KINDS, missingFrom, render, valuesOf } from './extract'

// Change a tag when a value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const pending = atom({ plugin: 'anchors', key: 'pending' } as const, [], { shape: 'pending-1' })
const last = atom({ plugin: 'anchors', key: 'last' } as const, null, { shape: 'last-1' })

const BLOCK = 'detailsBeforeCompaction'
const LOG_KEY = 'compactions'
const LOG_MAX = 500
// A long tool result (a whole file) is read up to this much.
const MAX_CHARS_PER_MESSAGE = 20_000

/** Everything in a message the model read: its text, tool calls and results. */
function textOf(m: SessionMessage): string {
  const parts: string[] = [m.text]
  for (const u of m.toolUses) {
    parts.push(valuesOf(u.input))
    if (u.text) parts.push(u.text)
  }
  for (const r of m.toolResults ?? []) parts.push(r.text)
  const text = parts.join('\n')
  return text.length > MAX_CHARS_PER_MESSAGE ? text.slice(0, MAX_CHARS_PER_MESSAGE) : text
}

async function readLog($: Engine): Promise<CompactionRecord[]> {
  const v = await $.store.get(LOG_KEY)
  return Array.isArray(v) ? (v as CompactionRecord[]) : []
}

function pct(a: number, b: number): string {
  return b === 0 ? '0%' : `${Math.round((a / b) * 100)}%`
}

function describeLast(record: CompactionRecord, putBack: readonly StoredAnchor[]): string {
  const lines = [
    `Last compaction (${record.trigger}): ${record.found} details found, the summary kept ${record.inSummary} (${pct(record.inSummary, record.found)}), ${putBack.length} put back.`,
  ]
  for (const kind of KINDS) {
    const k = record.byKind[kind]
    if (k) lines.push(`  ${kind.padEnd(7)} ${k[1]}/${k[0]} kept by the summary`)
  }
  if (putBack.length) {
    lines.push('', 'Put back:')
    for (const a of putBack.slice(0, 40)) lines.push(`  ${a.kind.padEnd(7)} ${a.value}`)
    if (putBack.length > 40) lines.push(`  ... and ${putBack.length - 40} more`)
  }
  return lines.join('\n')
}

function describeStats(log: readonly CompactionRecord[]): string {
  if (!log.length) return 'No compactions recorded yet.'
  const found = log.reduce((s, r) => s + r.found, 0)
  const kept = log.reduce((s, r) => s + r.inSummary, 0)
  const lines = [
    `${log.length} compactions: ${found} details found, the summaries kept ${kept} (${pct(kept, found)}).`,
  ]
  for (const kind of KINDS) {
    let f = 0
    let k = 0
    for (const r of log) {
      const v = r.byKind[kind]
      if (v) {
        f += v[0]
        k += v[1]
      }
    }
    if (f) lines.push(`  ${kind.padEnd(7)} ${pct(k, f).padStart(4)} kept  (${k}/${f})`)
  }
  return lines.join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'anchors',
      description: 'What the last compaction summary dropped and was put back; "stats" for all compactions',
      argumentHint: '[stats]',
    })
    return next(e)
  })

  on('command.run', { command: 'anchors' }, async ($, e) => {
    if (e.args.trim() === 'stats') return { text: describeStats(await readLog($)) }
    const l = await read($, last)
    return { text: l ? describeLast(l.record, l.putBack) : 'No compaction in this session yet.' }
  })

  // The main conversation only; a precompute installs nothing, and the
  // compaction that uses it fires again with its own trigger.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)

    const anchors = anchorsOf(e.messages.map(textOf))
    const result = await next(e)
    if (result.skip !== undefined) return result

    const summary = result.messages.map(textOf).join('\n')
    const putBack = missingFrom(summary, anchors)
    const found = countByKind(anchors)
    const dropped = countByKind(putBack)
    const byKind: CompactionRecord['byKind'] = {}
    for (const kind of KINDS) {
      const f = found[kind] ?? 0
      if (f) byKind[kind] = [f, f - (dropped[kind] ?? 0)]
    }
    const record: CompactionRecord = {
      at: await $.clock.now(),
      trigger: e.trigger,
      found: anchors.length,
      inSummary: anchors.length - putBack.length,
      byKind,
    }

    await update($, pending, () => putBack)
    await update($, last, () => ({ record, putBack }))
    const log = await readLog($)
    await $.store.set(LOG_KEY, [...log, record].slice(-LOG_MAX))
    $.ui.invalidate('prompt.context')

    if (anchors.length) {
      $.ui.toast(
        `anchors: the summary kept ${record.inSummary} of ${record.found} details; ${putBack.length} put back (/anchors)`,
      )
    }
    return result
  }).catch(($, e, next) => next(e)) // a failure here never blocks the compaction

  // Read once after a compaction: the block goes into the conversation then
  // and stays. Taken off `pending` so a later /clear starts clean.
  on('prompt.context', async ($, e, next) => {
    const res = await next(e)
    const putBack = await read($, pending)
    if (!putBack.length) return res
    await update($, pending, () => [])
    return { ...res, blocks: [...res.blocks.filter(b => b.name !== BLOCK), { name: BLOCK, text: render(putBack) }] }
  })
}
