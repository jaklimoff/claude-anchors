export type AnchorKind = 'path' | 'commit' | 'issue' | 'error' | 'url' | 'kv' | 'ip'

export type StoredAnchor = { kind: AnchorKind; value: string; count: number; last: number }

/** One compaction, as the mod saw it. */
export type CompactionRecord = {
  at: number
  trigger: string
  /** Details found in the conversation before the compaction. */
  found: number
  /** Of those, how many the summary still holds word for word. */
  inSummary: number
  byKind: Partial<Record<AnchorKind, [found: number, inSummary: number]>>
}

declare module 'claude-code' {
  interface PluginState {
    anchors: {
      /** Set by a compaction, read once by the context that follows it. */
      pending: Shaped<StoredAnchor[]>
      /** The last compaction: what it found and what was put back. */
      last: Shaped<{ record: CompactionRecord; putBack: StoredAnchor[] } | null>
    }
  }
}
