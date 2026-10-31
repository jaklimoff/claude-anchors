// Pulls exact details out of a conversation with plain regexes, no model.
// The kinds follow Compact-Bench (arXiv 2610.31710): paths, commit SHAs,
// PR and issue ids, error types, URLs, key=value pairs and IP addresses.

export type Kind = 'path' | 'commit' | 'issue' | 'error' | 'url' | 'kv' | 'ip'

export const KINDS: readonly Kind[] = ['path', 'commit', 'issue', 'error', 'url', 'kv', 'ip']

export type Anchor = { kind: Kind; value: string; count: number; last: number }

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]}]+/g
const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?\b/g
// Short (7 to 12) or full (40) commit hashes; a 32-character hash is not a commit.
const SHA_RE = /\b(?:[0-9a-f]{7,12}|[0-9a-f]{40})\b/g
// owner/repo#123, or a bare #12 to #99999 (not #1 list markers, not #495057 colors)
const REPO_ISSUE_RE = /\b[\w.-]{2,}\/[\w.-]{2,}#\d{1,6}\b/g
const BARE_ISSUE_RE = /(?<![\w/&#])#\d{2,5}(?![\w])/g
const ISSUE_WORD_RE = /\b(?:PR|pull request|issue)\s+#?(\d{1,6})\b/gi
const ERROR_RE = /\b[A-Z][A-Za-z0-9]*(?:Error|Exception)\b/g
const ERRNO_RE =
  /\bE(?:NOENT|ACCES|PERM|EXIST|CONNREFUSED|CONNRESET|ADDRINUSE|TIMEDOUT|NOTDIR|ISDIR|PIPE|NOTFOUND|AGAIN|MFILE|NOSPC|NOTEMPTY)\b/g
const ABS_PATH_RE = /(?<![\w$}\])])(?:~|\.{1,2})?\/(?:[\w.@+-]+\/)*[\w.@+-]+/g
// Not after $: "$DIR/files.txt" is a shell variable, not the path "DIR/files.txt".
const REL_PATH_RE = /(?<![$\w.@+-])[\w.@+-]+(?:\/[\w.@+-]+)+/g
const FILE_RE =
  /\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|rb|java|kt|swift|cpp|hpp|php|sh|zsh|sql|md|mdx|json|jsonc|yaml|yml|toml|ini|env|lock|css|scss|html|vue|svelte|proto|tf)\b/gi
const KV_RE = /(?<![\w.$])(--)?([A-Za-z_][A-Za-z0-9_.-]{0,40})=("[^"\n]{1,80}"|'[^'\n]{1,80}'|[^\s,;'"`)\]}=>][^\s,;'"`)\]}]{0,79})/g
// A setting, not code: ENV_STYLE, dotted.or-kebab keys, or a --flag=value.
const ENV_KEY = /^[A-Z][A-Z0-9_]+$/
const CONFIG_KEY = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/
const CODE_VALUE = /[({\[]|^[$<\\]|^(?:lambda|function|new|await)\b/
// data-testid="x", stroke-width="1.5": an HTML or SVG attribute, not a setting.
const HTML_ATTR = /^(?:data|aria)-|^(?:stroke|fill|font|text|view|xml|class|style|width|height)(?:-|$)/
const JUNK_PATHS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr'])

// Values that look like credentials never go back into the context.
const SECRET_KEY = /token|secret|passw|pwd|api[_-]?key|auth|cookie|credential|session|private/i
const SECRET_VALUE = /^(?:sk-|ghp_|gho_|github_pat_|xox[bap]-|AKIA|eyJ)|[A-Za-z0-9+/_-]{32,}/

function isSha(s: string): boolean {
  return /[a-f]/.test(s) && /\d/.test(s) && !/^\d+$/.test(s)
}

function isIp(s: string): boolean {
  const host = s.split(':')[0] ?? ''
  return host.split('.').every(n => Number(n) <= 255)
}

function cleanPath(p: string): string {
  return p.replace(/[.,:;]+$/, '')
}

const MIME = /^(?:image|text|application|audio|video|font|multipart)\/[\w.+-]+$/

function isPath(p: string): boolean {
  if (p.length < 3 || p.length > 200) return false
  if (MIME.test(p) || JUNK_PATHS.has(p)) return false
  // "/tasks" is a slash command: a one-part absolute path needs an extension.
  if (/^\/[^/]+$/.test(p) && !/\.[A-Za-z]\w{0,7}$/.test(p)) return false
  // A relative path needs a file extension or three parts: not "and/or", "R2/3".
  if (!/^[~./]/.test(p) && p.includes('/')) {
    const parts = p.split('/')
    if (parts.length < 3 && !/\.[A-Za-z]\w{0,7}$/.test(parts[parts.length - 1] ?? '')) return false
  }
  if (/^\/+$/.test(p) || /^\d+(\/\d+)+$/.test(p)) return false // "/", dates like 10/31/2026
  if (/^[\d.]+\/[\d.]+$/.test(p)) return false // ratios like 3/4
  if (!/[A-Za-z]/.test(p)) return false
  return true
}

/** The details in one text, each with its kind, in the order found. */
export function extract(text: string): { kind: Kind; value: string }[] {
  const found: { kind: Kind; value: string }[] = []
  const add = (kind: Kind, value: string) => found.push({ kind, value })

  for (const m of text.matchAll(URL_RE)) add('url', m[0].replace(/[.,:;!?\\]+$/, ''))
  // Paths, SHAs and pairs inside a URL belong to the URL.
  const rest = text.replace(URL_RE, ' ')

  for (const m of rest.matchAll(IP_RE)) if (isIp(m[0])) add('ip', m[0])
  const noIp = rest.replace(IP_RE, ' ')

  for (const m of noIp.matchAll(SHA_RE)) if (isSha(m[0])) add('commit', m[0])
  for (const m of noIp.matchAll(REPO_ISSUE_RE)) add('issue', m[0])
  for (const m of noIp.matchAll(BARE_ISSUE_RE)) add('issue', m[0])
  for (const m of noIp.matchAll(ISSUE_WORD_RE)) add('issue', `#${m[1]}`)
  for (const m of noIp.matchAll(ERROR_RE)) add('error', m[0])
  for (const m of noIp.matchAll(ERRNO_RE)) add('error', m[0])

  for (const m of noIp.matchAll(KV_RE)) {
    const flag = m[1] ?? ''
    const key = m[2] ?? ''
    const value = m[3] ?? ''
    if (!flag && !ENV_KEY.test(key) && !CONFIG_KEY.test(key)) continue
    if (!flag && HTML_ATTR.test(key)) continue
    const v = value.replace(/[.,:;]+$/, '')
    if (!v || CODE_VALUE.test(v)) continue
    if (SECRET_KEY.test(key) || SECRET_VALUE.test(v)) continue
    add('kv', `${flag}${key}=${v}`)
  }

  const paths = new Set<string>()
  for (const re of [ABS_PATH_RE, REL_PATH_RE, FILE_RE]) {
    for (const m of noIp.matchAll(re)) {
      const p = cleanPath(m[0])
      if (isPath(p)) paths.add(p)
    }
  }
  // Keep the longest form: "src/a.ts" covers "a.ts" found on its own.
  const all = [...paths]
  for (const p of all) {
    if (!all.some(o => o !== p && o.length > p.length && o.endsWith(p))) add('path', p)
  }
  const once = new Set<string>()
  return found.filter(f => {
    const k = `${f.kind}\u0000${f.value}`
    return once.has(k) ? false : (once.add(k), true)
  })
}

export type Options = {
  /** How many of each kind to keep; Compact-Bench's reference keeps 40. */
  perKind?: number
  /** Messages at the end of the history that count as recent. */
  recent?: number
}

/**
 * The details worth keeping across a compaction: the ones that came up in
 * two or more messages, or in the last few, most used first.
 */
export function anchorsOf(messages: readonly string[], opts: Options = {}): Anchor[] {
  const perKind = opts.perKind ?? 40
  const recent = opts.recent ?? 12
  const seen = new Map<string, Anchor>()

  messages.forEach((text, i) => {
    const inThis = new Set<string>()
    for (const { kind, value } of extract(text)) {
      const key = `${kind}\u0000${value}`
      if (inThis.has(key)) continue
      inThis.add(key)
      const a = seen.get(key)
      if (a) {
        a.count++
        a.last = i
      } else seen.set(key, { kind, value, count: 1, last: i })
    }
  })

  const cutoff = messages.length - recent
  const out: Anchor[] = []
  for (const kind of KINDS) {
    const ofKind = [...seen.values()]
      .filter(a => a.kind === kind && (a.count >= 2 || a.last >= cutoff))
      .sort((a, b) => b.count - a.count || b.last - a.last || a.value.localeCompare(b.value))
      .slice(0, perKind)
    out.push(...ofKind)
  }
  return out
}

/** The anchors a summary left out: a plain membership test, as the paper scores it. */
export function missingFrom(summary: string, anchors: readonly Anchor[]): Anchor[] {
  return anchors.filter(a => !summary.includes(a.value))
}

const LABEL: Record<Kind, string> = {
  path: 'Files and paths',
  commit: 'Commits',
  issue: 'PRs and issues',
  error: 'Error types',
  url: 'URLs',
  kv: 'Settings (key=value)',
  ip: 'IP addresses',
}

/** The context block the model reads after the compaction. */
export function render(anchors: readonly Anchor[], maxChars = 6000): string {
  const lines = [
    'Exact details from before the last compaction that its summary left out.',
    'They came up more than once or near the end. Use them as written; check before you rely on one.',
  ]
  for (const kind of KINDS) {
    const vals = anchors.filter(a => a.kind === kind).map(a => a.value)
    if (vals.length) lines.push('', `${LABEL[kind]}:`, ...vals.map(v => `- ${v}`))
  }
  let text = lines.join('\n')
  if (text.length > maxChars) {
    text = text.slice(0, maxChars)
    text = text.slice(0, text.lastIndexOf('\n')) + '\n(more left out)'
  }
  return text
}

export function countByKind(anchors: readonly Anchor[]): Partial<Record<Kind, number>> {
  const c: Partial<Record<Kind, number>> = {}
  for (const a of anchors) c[a.kind] = (c[a.kind] ?? 0) + 1
  return c
}

/** The strings inside a tool call's input, one per line: no JSON escaping. */
export function valuesOf(input: unknown, depth = 0): string {
  if (typeof input === 'string') return input
  if (typeof input === 'number' || typeof input === 'boolean') return String(input)
  if (depth > 6 || input === null || typeof input !== 'object') return ''
  const vals = Array.isArray(input) ? input : Object.values(input)
  return vals.map(v => valuesOf(v, depth + 1)).filter(Boolean).join('\n')
}
