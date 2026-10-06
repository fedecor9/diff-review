# diff-review

A [reviewr](https://github.com/persiyanov/herdr-reviewr)-style review pane inside Claude Code. Read the
agent's diff beside the chat, comment on hunks, and send the comments back to the prompt.

- **Changes:** the diff with syntax highlighting and a Files sidebar grouped by folder.
  Four scopes: uncommitted, branch (vs `origin/HEAD`), last turn, last commit.
- **MR / PR:** the branch's merge request (GitLab, via `glab`) or pull request (GitHub, via `gh`):
  state, checks, description and comments, read-only.
- **Pipeline:** the branch's latest pipeline as a vertical diagram of stages, each listing its jobs,
  their times and the command a running job is on. Live while it runs.

## Install

In a Claude Code terminal session:

```
/plugin install diff-review --marketplace <owner>/<repo>
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

Needs `git`. The MR/PR and Pipeline tabs need `glab` (GitLab) or `gh` (GitHub), authenticated.

## Use

`/diff-review` opens the pane; it also opens on its own at session start when the terminal is at
least 144 columns wide. `ctrl+x tab` gives the pane the keyboard, `Esc` hands it back to the chat;
the top-right corner says which side has it.

| Key | Changes tab |
| --- | --- |
| `1` `2` `3` | Changes / MR / Pipeline tab |
| `u` `b` `t` `g` | Scope: uncommitted, branch, last turn, last commit |
| `f` | Switch focus between the diff and the Files sidebar |
| `j` `k` | Next / previous hunk (diff focused) or file (Files focused) |
| `n` `p` | Next / previous hunk, across files |
| `l` | Back to the diff from the Files sidebar |
| `c` | Comment on the current hunk |
| `s` | Send every comment to the prompt box (not submitted) |
| `x` | Clear comments |
| `z` | Hide / show the Files sidebar |
| `r` | Refresh |

| Key | MR and Pipeline tabs |
| --- | --- |
| `j` `k` | Select a stage (Pipeline) |
| `l` / `h` | Zoom into the selected stage / back |
| `o` | Open in the browser |
| `r` | Refresh |
| `↑` `↓` | Scroll |

## How it reads changes

The uncommitted, branch and last-turn scopes snapshot the working tree (untracked files included,
`.gitignore` respected) through a scratch git index, so the real index is never touched. The
last-turn scope snapshots when each turn starts and diffs against it.

## Develop

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```
