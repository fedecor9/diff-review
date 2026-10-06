import { expect, test } from 'claude-code/testing'

import { fileTree, fitHunk, formatComments, hunkRows, hunksInView, parseDiff, sortByFolder } from './diff'

const SAMPLE = [
  'diff --git a/lib/app.dart b/lib/app.dart',
  'index 1111111..2222222 100644',
  '--- a/lib/app.dart',
  '+++ b/lib/app.dart',
  '@@ -1,4 +1,4 @@ class App',
  ' line one',
  '-old two',
  '+new two',
  ' line three',
  '@@ -20,2 +20,3 @@',
  ' tail',
  '+added',
  ' end',
  'diff --git a/README.md b/README.md',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/README.md',
  '@@ -0,0 +1,2 @@',
  '+# Title',
  '+body',
  '\\ No newline at end of file',
  'diff --git a/gone.txt b/gone.txt',
  'deleted file mode 100644',
  '--- a/gone.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-bye',
  '',
].join('\n')

test('parseDiff splits files, hunks and counts', async () => {
  const files = parseDiff(SAMPLE)

  expect(files.map(file => [file.path, file.status, file.added, file.removed])).toEqual([
    ['lib/app.dart', 'modified', 2, 1],
    ['README.md', 'added', 2, 0],
    ['gone.txt', 'deleted', 0, 1],
  ])
  expect(files[0]?.hunks.length).toBe(2)
  expect(files[1]?.hunks[0]).toBe('@@ -0,0 +1,2 @@\n+# Title\n+body')
})

test('fitHunk cuts a tall hunk and rewrites its header counts', async () => {
  const hunk = ['@@ -10,5 +10,5 @@ fn', ' a', '-b', '+c', ' d', ' e'].join('\n')

  expect(fitHunk(hunk, 10)).toBe(hunk)
  expect(fitHunk(hunk, 4)).toBe(['@@ -10,2 +10,2 @@ fn', ' a', '-b', '+c'].join('\n'))
})

test('hunksInView fills the budget with whole hunks after the first', async () => {
  const hunks = ['@@ -1 +1 @@\n-a\n+b', '@@ -5 +5 @@\n-c\n+d', '@@ -9 +9 @@\n-e\n+f']

  expect(hunksInView(hunks, 0, 6)).toEqual([hunks[0], hunks[1]])
  expect(hunksInView(hunks, 2, 6)).toEqual([hunks[2]])
})

test('formatComments names the file and hunk with the snippet', async () => {
  const text = formatComments([
    { path: 'lib/app.dart', hunkHeader: '@@ -1,4 +1,4 @@', snippet: '-old\n+new', text: 'Why rename?' },
  ])

  expect(text).toContain('lib/app.dart @@ -1,4 +1,4 @@')
  expect(text).toContain('```diff\n-old\n+new\n```\nWhy rename?')
})

test('hunkRows numbers old and new lines from the header', async () => {
  const rows = hunkRows(['@@ -10,3 +10,3 @@ fn', ' keep', '-old', '+new', ' end'].join('\n'))

  expect(rows).toEqual([
    { kind: 'header', text: '@@ -10,3 +10,3 @@ fn' },
    { kind: 'context', text: 'keep', oldLine: 10, newLine: 10 },
    { kind: 'remove', text: 'old', oldLine: 11 },
    { kind: 'add', text: 'new', newLine: 11 },
    { kind: 'context', text: 'end', oldLine: 12, newLine: 12 },
  ])
})

test('fileTree groups files under one row per folder', async () => {
  const files = parseDiff(SAMPLE)

  expect(fileTree(files)).toEqual([
    { kind: 'dir', path: 'lib/' },
    { kind: 'file', index: 0, name: 'app.dart', isNested: true },
    { kind: 'file', index: 1, name: 'README.md', isNested: false },
    { kind: 'file', index: 2, name: 'gone.txt', isNested: false },
  ])
})

test('sortByFolder keeps a folder\'s files together under one heading', async () => {
  const file = (path: string) => ({ path, status: 'modified' as const, added: 1, removed: 0, hunks: [] })
  const sorted = sortByFolder([file('.maestro/README.md'), file('.maestro/auth/login.yaml'), file('.maestro/z.yaml')])

  expect(sorted.map(one => one.path)).toEqual(['.maestro/README.md', '.maestro/z.yaml', '.maestro/auth/login.yaml'])
  expect(fileTree(sorted).filter(row => row.kind === 'dir').map(row => row.kind === 'dir' && row.path)).toEqual([
    '.maestro/',
    '.maestro/auth/',
  ])
})
