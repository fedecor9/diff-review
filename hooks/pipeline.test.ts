import { expect, test } from 'claude-code/testing'

import { currentCommand, elapsed, parseGithubRun, parseGitlabPipeline, stageSpan, stageStatus } from './pipeline'

test('parseGitlabPipeline orders stages by first job id and folds job statuses', async () => {
  const pipeline = parseGitlabPipeline(
    JSON.stringify({
      id: 7,
      status: 'running',
      ref: 'refs/merge-requests/678/merge',
      web_url: 'https://gitlab.com/g/r/-/pipelines/7',
      started_at: '2026-10-05T13:37:00Z',
      jobs: [
        { id: 13, name: 'test', stage: 'test', status: 'running', started_at: '2026-10-05T13:38:00Z' },
        { id: 12, name: 'lint', stage: 'test', status: 'success', started_at: '2026-10-05T13:38:00Z', finished_at: '2026-10-05T13:39:00Z' },
        { id: 11, name: 'build-builder', stage: 'build', status: 'success', started_at: '2026-10-05T13:37:00Z', finished_at: '2026-10-05T13:38:00Z' },
      ],
    }),
  )

  expect(pipeline.ref).toBe('!678 merge')
  expect(pipeline.stages.map(stage => [stage.name, stage.status, stage.jobs.map(job => job.name)])).toEqual([
    ['build', 'success', ['build-builder']],
    ['test', 'running', ['lint', 'test']],
  ])
})

test('stageStatus lets an allowed failure pass and waits on pending jobs', async () => {
  const job = (status: any, isAllowedToFail = false) => ({ id: status, name: status, status, isAllowedToFail })

  expect(stageStatus([job('success'), job('failed', true)])).toBe('success')
  expect(stageStatus([job('success'), job('failed')])).toBe('failed')
  expect(stageStatus([job('success'), job('pending')])).toBe('running')
  expect(stageStatus([job('pending'), job('pending')])).toBe('pending')
})

test('currentCommand finds the last $ command and its latest output in a trace', async () => {
  const trace = [
    '2026-10-05T13:38:43.829443Z 00O+section_start:1791207523:step_script',
    '2026-10-05T13:38:44.328306Z 01O $ [ -d /opt/app ] && cd /opt/app',
    '2026-10-05T13:38:44.328320Z 01O \u001b[32;1m$ scripts/ci/test.sh --with-coverage\u001b[0;m',
    '2026-10-05T13:42:08.076219Z 01O 00:42 +120: All tests passed',
    '2026-10-05T13:42:08.076229Z 01O ',
  ].join('\n')

  expect(currentCommand(trace)).toEqual({ command: 'scripts/ci/test.sh --with-coverage', output: '00:42 +120: All tests passed' })
  expect(currentCommand('no commands here')).toEqual({})
})

test('stageSpan and elapsed time a stage from its first start to its last finish', async () => {
  const stage = {
    name: 'test',
    status: 'success' as const,
    jobs: [
      { id: '1', name: 'a', status: 'success' as const, isAllowedToFail: false, startedAt: '2026-01-01T00:00:10Z', finishedAt: '2026-01-01T00:01:00Z' },
      { id: '2', name: 'b', status: 'success' as const, isAllowedToFail: false, startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:03:05Z' },
    ],
  }
  const span = stageSpan(stage)

  expect(elapsed(span.startedAt, span.finishedAt, 0)).toBe('3m 05s')
  expect(elapsed('2026-01-01T00:00:00Z', undefined, Date.parse('2026-01-01T00:00:42Z'))).toBe('42s')
  expect(elapsed(undefined, undefined, 0)).toBe('—')
})

test('parseGithubRun maps each job to a stage with its running step as current', async () => {
  const run = parseGithubRun(
    JSON.stringify({
      databaseId: 9,
      workflowName: 'CI',
      status: 'in_progress',
      url: 'https://github.com/o/r/actions/runs/9',
      headBranch: 'feat',
      jobs: [
        {
          databaseId: 1,
          name: 'build',
          status: 'in_progress',
          steps: [
            { number: 1, name: 'Checkout', status: 'completed', conclusion: 'success' },
            { number: 2, name: 'Run tests', status: 'in_progress' },
          ],
        },
      ],
    }),
  )

  expect(run.status).toBe('running')
  expect(run.stages[0]?.current).toBe('Run tests')
  expect(run.stages[0]?.jobs.map(step => step.status)).toEqual(['success', 'running'])
})
