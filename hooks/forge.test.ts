import { expect, test } from 'claude-code/testing'

import { checksColor, parseGithub, parseGitlab } from './forge'

test('parseGitlab reads the MR and keeps only human notes', async () => {
  const view = parseGitlab(
    JSON.stringify({
      iid: 12,
      title: 'Add dark mode toggle',
      state: 'opened',
      draft: false,
      web_url: 'https://gitlab.com/group/repo/-/merge_requests/12',
      author: { username: 'dev' },
      source_branch: 'feature/x',
      target_branch: 'main',
      head_pipeline: { status: 'success' },
      detailed_merge_status: 'discussions_not_resolved',
      description: '## Description',
      Discussions: [
        { notes: [{ system: true, body: 'assigned to @dev', author: { username: 'dev' } }] },
        {
          notes: [
            {
              system: false,
              body: 'Rename this?',
              author: { username: 'reviewer' },
              created_at: '2026-10-05T14:00:00Z',
              resolvable: true,
              resolved: false,
              position: { new_path: 'lib/a.dart', new_line: 12 },
            },
          ],
        },
      ],
    }),
  )

  expect(view.number).toBe('!12')
  expect(view.checks).toBe('success')
  expect(view.notes).toEqual([
    { author: 'reviewer', body: 'Rename this?', createdAt: '2026-10-05T14:00:00Z', path: 'lib/a.dart', line: 12, isResolved: false },
  ])
})

test('parseGithub folds check runs into one status and merges comments with reviews', async () => {
  const view = parseGithub(
    JSON.stringify({
      number: 42,
      title: 'Add thing',
      state: 'OPEN',
      isDraft: true,
      url: 'https://github.com/o/r/pull/42',
      author: { login: 'dev' },
      headRefName: 'feat',
      baseRefName: 'main',
      body: 'Body',
      statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }],
      mergeStateStatus: 'BLOCKED',
      comments: [{ author: { login: 'b' }, body: 'second', createdAt: '2026-01-02' }],
      reviews: [
        { author: { login: 'a' }, body: 'first', submittedAt: '2026-01-01' },
        { author: { login: 'c' }, body: '', submittedAt: '2026-01-03' },
      ],
    }),
  )

  expect(view.state).toBe('draft · open')
  expect(view.checks).toBe('failed')
  expect(view.mergeStatus).toBe('blocked')
  expect(view.notes.map(note => note.author)).toEqual(['a', 'b'])
})

test('checksColor maps statuses to colors', async () => {
  expect(checksColor('success')).toBe('green')
  expect(checksColor('failed')).toBe('red')
  expect(checksColor('running')).toBe('yellow')
  expect(checksColor(undefined)).toBe(undefined)
})
