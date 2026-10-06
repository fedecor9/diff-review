import type { DiffFile, ReviewComment } from '../types'

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

export function parseDiff(output: string): DiffFile[] {
  return output
    .split(/^diff --git /m)
    .filter(chunk => chunk.trim().length > 0)
    .map(parseFile)
}

function parseFile(chunk: string): DiffFile {
  const lines = chunk.split('\n')
  const oldPath = lines.find(line => line.startsWith('--- '))?.slice(4)
  const newPath = lines.find(line => line.startsWith('+++ '))?.slice(4)
  const renamedTo = lines.find(line => line.startsWith('rename to '))?.slice(10)
  const firstLine = lines[0] ?? ''
  const headerPath = firstLine.split(' b/').pop() ?? firstLine

  const path =
    newPath && newPath !== '/dev/null'
      ? newPath.replace(/^b\//, '')
      : oldPath && oldPath !== '/dev/null'
        ? oldPath.replace(/^a\//, '')
        : (renamedTo ?? headerPath)

  const hunkLines: string[][] = []
  for (const line of lines) {
    if (line.startsWith('@@')) {
      hunkLines.push([line])
    } else if (hunkLines.length > 0 && line !== '\\ No newline at end of file') {
      hunkLines.at(-1)?.push(line)
    }
  }
  const trimmed = hunkLines.map(hunk => hunk.join('\n').replace(/\n+$/, ''))

  const body = trimmed.flatMap(hunk => hunk.split('\n').slice(1))
  const added = body.filter(line => line.startsWith('+')).length
  const removed = body.filter(line => line.startsWith('-')).length

  const status: DiffFile['status'] = chunk.includes('\nBinary files ')
    ? 'binary'
    : oldPath === '/dev/null'
      ? 'added'
      : newPath === '/dev/null'
        ? 'deleted'
        : renamedTo
          ? 'renamed'
          : 'modified'

  return { path, status, added, removed, hunks: trimmed }
}

// Cuts a hunk to at most `maxLines` lines (header included) and rewrites the
// header counts, so the result still parses as a unified-diff hunk.
export function fitHunk(hunk: string, maxLines: number): string {
  const lines = hunk.split('\n')
  if (lines.length <= maxLines) return hunk

  const match = HUNK_HEADER.exec(lines[0] ?? '')
  if (!match) return lines.slice(0, maxLines).join('\n')

  const body = lines.slice(1, Math.max(2, maxLines))
  const oldCount = body.filter(line => !line.startsWith('+')).length
  const newCount = body.filter(line => !line.startsWith('-')).length
  const header = `@@ -${match[1]},${oldCount} +${match[3]},${newCount} @@${match[5]}`

  return [header, ...body].join('\n')
}

// The hunks from `start` onward that fit in `budget` lines; the first one is
// always shown, cut to fit when it alone is taller than the budget.
export function hunksInView(hunks: string[], start: number, budget: number): string[] {
  const shown: string[] = []
  let used = 0
  for (const hunk of hunks.slice(start)) {
    const height = hunk.split('\n').length
    if (shown.length === 0) {
      shown.push(fitHunk(hunk, budget))
      used = Math.min(height, budget)
    } else if (used + height <= budget) {
      shown.push(hunk)
      used += height
    } else {
      break
    }
  }
  return shown
}

export type HunkRow =
  | { kind: 'header'; text: string }
  | { kind: 'context' | 'add' | 'remove'; text: string; oldLine?: number; newLine?: number }

// One row per hunk line, numbered on the old and new side from the header.
export function hunkRows(hunk: string): HunkRow[] {
  const [header = '', ...body] = hunk.split('\n')
  const match = HUNK_HEADER.exec(header)
  let oldLine = Number(match?.[1] ?? 0)
  let newLine = Number(match?.[3] ?? 0)

  const rows: HunkRow[] = [{ kind: 'header', text: header }]
  for (const line of body) {
    const text = line.slice(1)
    if (line.startsWith('+')) {
      rows.push({ kind: 'add', text, newLine: newLine++ })
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'remove', text, oldLine: oldLine++ })
    } else {
      rows.push({ kind: 'context', text, oldLine: oldLine++, newLine: newLine++ })
    }
  }
  return rows
}

// Orders files by folder, then name, so each folder's files sit together
// under one sidebar row (git's path order puts `a/z.md` after `a/b/c.md`).
export function sortByFolder(files: DiffFile[]): DiffFile[] {
  const folderOf = (path: string) => path.slice(0, path.lastIndexOf('/') + 1)
  return [...files].sort(
    (left, right) => folderOf(left.path).localeCompare(folderOf(right.path)) || left.path.localeCompare(right.path),
  )
}

export type TreeRow = { kind: 'dir'; path: string } | { kind: 'file'; index: number; name: string; isNested: boolean }

// The sidebar's rows: files grouped under a row per folder, in diff order
// (git sorts by path, so each folder's files arrive together).
export function fileTree(files: DiffFile[]): TreeRow[] {
  const rows: TreeRow[] = []
  let currentDir = ''
  files.forEach((file, index) => {
    const slash = file.path.lastIndexOf('/')
    const dir = slash === -1 ? '' : file.path.slice(0, slash + 1)
    if (dir !== currentDir && dir !== '') rows.push({ kind: 'dir', path: dir })
    currentDir = dir
    rows.push({ kind: 'file', index, name: file.path.slice(slash + 1), isNested: dir !== '' })
  })
  return rows
}

export const STATUS_LETTER: Record<DiffFile['status'], string> = {
  added: 'A',
  deleted: 'D',
  modified: 'M',
  renamed: 'R',
  binary: 'B',
}

export function formatComments(comments: ReviewComment[]): string {
  const blocks = comments.map(comment =>
    [
      `${comment.path} ${comment.hunkHeader}`,
      '```diff',
      comment.snippet,
      '```',
      comment.text,
    ].join('\n'),
  )
  return `Review comments on the diff:\n\n${blocks.join('\n\n')}\n`
}
