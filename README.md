# anchors

A Claude Code plugin that keeps the exact details a compaction summary drops.

When Claude Code compacts a long conversation, a model writes a summary and the rest is gone. Summaries are good at the story and bad at strings: the file paths, commit hashes, error names and URLs you will need again. In my own sessions (103 compactions in October 2026, Claude Opus 5.5), the summary kept 36% of them. Error names and URLs: 13%. A third of what it dropped came up again later in the same session.

This plugin does the boring part with plain regexes. Right before a compaction it pulls those details out of the conversation. Right after, it checks which ones the summary still holds, word for word, and puts the rest back as a short block of context. No model call, nothing leaves your machine.

The idea comes from [Compact-Bench](https://arxiv.org/abs/2610.31710): over 146 coding sessions, the best LLM summary kept at most 16.0% of recurring details, against 79.1% for mechanical extraction.

## Install

```
/plugin marketplace add jaklimoff/claude-anchors
/plugin install anchors@anchors
```

## What it keeps

The seven kinds Compact-Bench measures:

| Kind | Examples |
|---|---|
| Files and paths | `src/lib/cache.ts`, `~/notes/todo.md`, `/etc/hosts` |
| Commits | `a1b2c3d`, full 40-character hashes |
| PRs and issues | `#128`, `acme/api#42` |
| Error types | `TypeError`, `ConnectionError`, `ENOENT` |
| URLs | `https://github.com/acme/api/pull/42` |
| Settings | `NODE_ENV=production`, `--window-size=390` |
| IP addresses | `10.0.0.12:4222` |

A detail is kept when it came up in two or more messages, or in the last twelve, most used first, up to 40 of each kind (Compact-Bench's own cap). Values under keys like `TOKEN`, `SECRET`, `PASSWORD`, `AUTH` and anything that looks like a key (`sk-...`, `ghp_...`, long random strings) are never put back.

## Use

Nothing to do: it runs on every compaction, `/compact` and auto alike. After one, a toast says how many details the summary kept and how many came back.

- `/anchors` shows the last compaction: what was found, what the summary kept, by kind, and what was put back.
- `/anchors stats` adds up every compaction it has seen.

A real one, from a session on one of my own projects:

```
Last compaction (manual): 65 details found, the summary kept 18 (28%), 47 put back.
  path    11/40 kept by the summary
  commit  4/12 kept by the summary
  error   0/5 kept by the summary
  url     2/3 kept by the summary
  kv      0/4 kept by the summary
  ip      1/1 kept by the summary
```

The block the model reads after the compaction starts like this:

```
Exact details from before the last compaction that its summary left out.
They came up more than once or near the end. Use them as written; check before you rely on one.

Files and paths:
- src/lib/cache.ts
...
```

## Check your own sessions

How much do your compactions keep? From a clone of this repo, with [Bun](https://bun.sh):

```
bun tools/score.ts
```

It reads the transcripts in `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`), finds every compaction, and scores the summary the same way. It only reads files. Mine, for October 2026:

```
103 compactions in 50 sessions: 7919 details found, the summaries kept 2843 (36%).
  path     44% kept  (1789/4084)
  commit   46% kept  (610/1317)
  issue    40% kept  (188/468)
  error    13% kept  (40/306)
  url      13% kept  (143/1131)
  kv        7% kept  (36/505)
  ip       34% kept  (37/108)
Of the 5076 dropped, 1656 (33%) came up again later in the same session.
```

## How it works

- A `session.compact` hook reads the conversation (text, tool calls and tool results) before the summary is made, runs the extractor, then lets the compaction run.
- It compares the details with the summary by plain string match, the same test Compact-Bench scores with.
- The missing ones go into the context the conversation carries after the compaction, once (a `prompt.context` block). A later `/clear` starts clean.
- Only the main conversation: subagents and the ahead-of-time compaction are left alone. If the plugin fails, the compaction goes on as usual.

## Limits

- It keeps strings, not meaning. The summary still decides what the work was about.
- A regex makes mistakes both ways: a 7-character hex word can pass as a commit, and a path written in an unusual way can be missed.
- More details back means a slightly bigger context after each compaction: the block is capped at 6,000 characters.

## License

MIT
