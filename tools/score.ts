// How much do your Claude Code compactions keep? Reads your session
// transcripts, finds each compaction, and checks which details from before it
// the summary still holds, word for word.
//
//   bun tools/score.ts                 # ~/.claude/projects, or $CLAUDE_CONFIG_DIR/projects
//   bun tools/score.ts path/to/*.jsonl # given transcripts
//
// Nothing is sent anywhere; it only reads files.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { anchorsOf, KINDS, missingFrom, valuesOf } from '../hooks/extract'

const MAX = 20_000

function transcripts(): string[] {
  const args = process.argv.slice(2)
  if (args.length) return args
  const root = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
  const out: string[] = []
  for (const dir of readdirSync(root)) {
    const d = join(root, dir)
    if (!statSync(d).isDirectory()) continue
    for (const f of readdirSync(d)) if (f.endsWith('.jsonl')) out.push(join(d, f))
  }
  return out
}

type Row = {
  type?: string
  subtype?: string
  isSidechain?: boolean
  isCompactSummary?: boolean
  compactMetadata?: { trigger?: string }
  message?: { content?: unknown }
}

function textOf(row: Row): string {
  const c = row.message?.content
  if (typeof c === 'string') return c.slice(0, MAX)
  if (!Array.isArray(c)) return ''
  const parts: string[] = []
  for (const b of c as Record<string, unknown>[]) {
    if (b.type === 'text') parts.push(String(b.text ?? ''))
    else if (b.type === 'tool_use') parts.push(valuesOf(b.input))
    else if (b.type === 'tool_result') {
      const r = b.content
      parts.push(typeof r === 'string' ? r : Array.isArray(r) ? r.map(x => String(x?.text ?? '')).join('\n') : '')
    }
  }
  return parts.join('\n').slice(0, MAX)
}

let compactions = 0
let found = 0
let kept = 0
let dropped = 0
let droppedLater = 0
const byKind = new Map<string, [number, number]>()
const sessions = new Set<string>()

for (const file of transcripts()) {
  let rows: Row[]
  try {
    rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => {
      try {
        return JSON.parse(l) as Row
      } catch {
        return {}
      }
    })
  } catch {
    continue
  }
  const msgs = rows
    .map((row, i) => ({ row, i }))
    .filter(({ row }) => (row.type === 'user' || row.type === 'assistant') && !row.isSidechain)
  const bounds = rows.flatMap((r, i) => (r.subtype === 'compact_boundary' ? [i] : []))

  bounds.forEach((b, k) => {
    const prev = k ? bounds[k - 1]! : -1
    const next = bounds[k + 1] ?? Infinity
    const history = msgs.filter(m => m.i > prev && m.i < b).map(m => textOf(m.row))
    const summaryRow = msgs.find(m => m.i > b && m.row.isCompactSummary)
    if (!summaryRow || history.length < 10) return

    const anchors = anchorsOf(history)
    const missing = new Set(missingFrom(textOf(summaryRow.row), anchors))
    const after = msgs.filter(m => m.i > summaryRow.i && m.i < next).map(m => textOf(m.row)).join('\n')

    compactions++
    sessions.add(file)
    found += anchors.length
    kept += anchors.length - missing.size
    dropped += missing.size
    for (const a of anchors) {
      const k2 = byKind.get(a.kind) ?? [0, 0]
      k2[0]++
      if (!missing.has(a)) k2[1]++
      else if (after.includes(a.value)) droppedLater++
      byKind.set(a.kind, k2)
    }
  })
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '-')

if (!compactions) {
  console.log('No compactions found in these transcripts.')
} else {
  console.log(`${compactions} compactions in ${sessions.size} sessions: ${found} details found, the summaries kept ${kept} (${pct(kept, found)}).`)
  for (const kind of KINDS) {
    const v = byKind.get(kind)
    if (v) console.log(`  ${kind.padEnd(7)} ${pct(v[1], v[0]).padStart(4)} kept  (${v[1]}/${v[0]})`)
  }
  console.log(`Of the ${dropped} dropped, ${droppedLater} (${pct(droppedLater, dropped)}) came up again later in the same session.`)
}
