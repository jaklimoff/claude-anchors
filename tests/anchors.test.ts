import { expect, mock, test } from 'claude-code/testing'

import { anchorsOf, extract, missingFrom, render } from '../hooks/extract'

const HISTORY = [
  'Fix the failing test in src/lib/cache.ts, it throws TypeError on empty input',
  'Read src/lib/cache.ts. Commit a1b2c3d4 changed it. See https://github.com/acme/api/pull/42',
  'Ran PORT=8080 bun test: TypeError: cannot read "at" of undefined at src/lib/cache.ts:12',
  'The fix is in src/lib/cache.ts; a1b2c3d4 broke it; pushed as acme/api#42 on 10.0.0.12:4222',
]

test('extract finds each kind and skips secrets, mime types and code', async () => {
  const kinds = (t: string) => extract(t).map(f => `${f.kind}:${f.value}`)

  expect(kinds('see src/app/main.ts and ~/notes/todo.md')).toEqual(
    expect.arrayContaining(['path:src/app/main.ts', 'path:~/notes/todo.md']),
  )
  expect(kinds('commit 9f3e2d1 and deadbeef1234, not the word decade')).toEqual(
    expect.arrayContaining(['commit:9f3e2d1', 'commit:deadbeef1234']),
  )
  expect(kinds('API_TOKEN=abc123 NODE_ENV=production')).toEqual(['kv:NODE_ENV=production'])
  expect(kinds('exist_ok=True and data=json.load(f)')).toEqual([])
  expect(kinds('content-type image/png and/or R2/3')).toEqual([])
  expect(kinds('color #495057 and item #1, but PR #128')).toEqual(['issue:#128'])
  expect(kinds('raised ConnectionError then ENOENT')).toEqual(['error:ConnectionError', 'error:ENOENT'])
})

test('a summary that drops details gets them back in the next context', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: Date.UTC(2026, 9, 31) })
  const anchors = anchorsOf(HISTORY)
  const summary = 'We fixed a failing test in the cache module.'
  const missing = missingFrom(summary, anchors)

  expect(anchors.map(a => a.value)).toEqual(
    expect.arrayContaining(['src/lib/cache.ts', 'a1b2c3d4', 'TypeError', 'PORT=8080']),
  )
  expect(missing.length).toBe(anchors.length)
  expect(render(missing)).toContain('- src/lib/cache.ts')

  // The engine's own compaction, beneath the mod: it reads the history and
  // answers with one summary message.
  on('session.compact', () => ({ messages: [{ role: 'user', text: summary, toolUses: [] }] }))
  on('prompt.context', (_, e) => ({ blocks: e.blocks }))
  on('ui.invalidate', () => ({ value: undefined }))
  const toasts: string[] = []
  on('ui.toast', (_, e) => (toasts.push(String((e as { text?: unknown }).text)), { value: undefined }))
  on('command.run', () => ({ text: 'engine' }))

  const messages = HISTORY.map((text, i) => ({
    role: i % 2 ? ('assistant' as const) : ('user' as const),
    text,
    toolUses: [],
  }))
  const done = await $.session.compact({ trigger: 'manual', messages })
  expect(done.skip).toBeUndefined()
  expect(toasts.join()).toContain('put back')

  const ctx = await $.prompt.context({ blocks: [] })
  const block = ctx.blocks.find(b => b.name === 'detailsBeforeCompaction')
  expect(block?.text).toContain('- src/lib/cache.ts')
  expect(block?.text).toContain('- PORT=8080')

  // Read once: the next re-read (a /clear) carries nothing.
  const again = await $.prompt.context({ blocks: [] })
  expect(again.blocks.map(b => b.name)).not.toContain('detailsBeforeCompaction')

  // /anchors reports what happened.
  const report = await $.command.run({ command: 'anchors', args: '', origin: { kind: 'person' } } as never)
  expect(report.text).toContain('put back')
})

test('a skipped compaction changes nothing', async ($, on) => {
  mock.store(on)
  on('session.compact', () => ({ skip: 'blocked' }))
  on('prompt.context', (_, e) => ({ blocks: e.blocks }))

  const messages = HISTORY.map(text => ({ role: 'user' as const, text, toolUses: [] }))
  expect((await $.session.compact({ trigger: 'auto', messages })).skip).toBe('blocked')
  const ctx = await $.prompt.context({ blocks: [] })
  expect(ctx.blocks).toEqual([])
})
