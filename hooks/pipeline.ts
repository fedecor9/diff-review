import type { Pipeline, PipelineJob, PipelineStage, PipelineStatus } from '../types'

type Json = Record<string, any>

const TRACE_PREFIX = /^\S+Z [0-9a-f]+[OE]\+?\s?/
const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g

export function normalizeStatus(raw: string | null | undefined): PipelineStatus {
  switch ((raw ?? '').toLowerCase()) {
    case 'success':
    case 'passed':
    case 'neutral':
      return 'success'
    case 'failed':
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
      return 'failed'
    case 'running':
    case 'in_progress':
      return 'running'
    case 'canceled':
    case 'cancelled':
      return 'canceled'
    case 'skipped':
      return 'skipped'
    case 'manual':
    case 'action_required':
      return 'manual'
    default:
      return 'pending'
  }
}

// A stage is as far along as its least-finished job; a failure that may fail
// does not fail the stage.
export function stageStatus(jobs: PipelineJob[]): PipelineStatus {
  const statuses = jobs.map(job => (job.status === 'failed' && job.isAllowedToFail ? 'success' : job.status))
  if (statuses.includes('running')) return 'running'
  if (statuses.includes('failed')) return 'failed'
  if (statuses.includes('canceled')) return 'canceled'
  if (statuses.includes('pending')) return statuses.some(status => status === 'success') ? 'running' : 'pending'
  if (statuses.includes('manual')) return 'manual'
  if (statuses.every(status => status === 'skipped')) return 'skipped'
  return 'success'
}

// Reads `glab ci get --output json`: stages ordered by their first job's id,
// which GitLab assigns in stage order.
export function parseGitlabPipeline(raw: string): Pipeline {
  const pipeline: Json = JSON.parse(raw)
  const jobs: Json[] = [...(pipeline.jobs ?? [])].sort((left, right) => left.id - right.id)

  const stages: PipelineStage[] = []
  for (const job of jobs) {
    let stage = stages.find(one => one.name === job.stage)
    if (!stage) {
      stage = { name: job.stage, status: 'pending', jobs: [] }
      stages.push(stage)
    }
    stage.jobs.push({
      id: String(job.id),
      name: job.name,
      status: normalizeStatus(job.status),
      startedAt: job.started_at ?? undefined,
      finishedAt: job.finished_at ?? undefined,
      isAllowedToFail: Boolean(job.allow_failure),
    })
  }
  for (const stage of stages) stage.status = stageStatus(stage.jobs)

  return {
    id: String(pipeline.id),
    name: `Pipeline #${pipeline.id}`,
    status: normalizeStatus(pipeline.status),
    url: pipeline.web_url ?? '',
    ref: String(pipeline.ref ?? '').replace(/^refs\/merge-requests\/(\d+)\/merge$/, '!$1 merge'),
    startedAt: pipeline.started_at ?? pipeline.created_at ?? undefined,
    finishedAt: pipeline.finished_at ?? undefined,
    stages,
  }
}

// Reads `gh run view --json`: GitHub has no stages, so each job is a stage
// and its steps are the jobs inside it, the running step its command.
export function parseGithubRun(raw: string): Pipeline {
  const run: Json = JSON.parse(raw)
  const stages: PipelineStage[] = (run.jobs ?? []).map((job: Json) => {
    const steps: PipelineJob[] = (job.steps ?? []).map((step: Json) => ({
      id: `${job.databaseId}-${step.number}`,
      name: step.name,
      status: normalizeStatus(step.status === 'completed' ? step.conclusion : step.status),
      startedAt: step.startedAt ?? undefined,
      finishedAt: step.completedAt ?? undefined,
      isAllowedToFail: false,
    }))
    const current = steps.find(step => step.status === 'running')
    return {
      name: job.name,
      status: normalizeStatus(job.status === 'completed' ? job.conclusion : job.status),
      jobs: steps,
      current: current?.name,
      startedAt: job.startedAt ?? undefined,
      finishedAt: job.completedAt ?? undefined,
    }
  })

  return {
    id: String(run.databaseId),
    name: run.workflowName ?? `Run #${run.databaseId}`,
    status: normalizeStatus(run.status === 'completed' ? run.conclusion : run.status),
    url: run.url ?? '',
    ref: run.headBranch ?? '',
    startedAt: run.createdAt ?? undefined,
    finishedAt: run.status === 'completed' ? run.updatedAt : undefined,
    stages,
  }
}

// The command a GitLab job is running: its trace's last `$ command` line, and
// the last line of output after it.
export function currentCommand(trace: string): { command?: string; output?: string } {
  const lines = trace
    .split('\n')
    .map(line => line.replace(ANSI, '').replace(TRACE_PREFIX, '').trimEnd())
    .filter(line => line.length > 0 && !line.startsWith('section_'))

  let commandAt = -1
  for (let index = lines.length - 1; index >= 0; index--) {
    if (lines[index]?.startsWith('$ ')) {
      commandAt = index
      break
    }
  }
  if (commandAt === -1) return {}
  const output = lines.slice(commandAt + 1).at(-1)
  return { command: lines[commandAt]?.slice(2), output }
}

// Earliest start and latest finish across a stage's jobs.
export function stageSpan(stage: PipelineStage): { startedAt?: string; finishedAt?: string } {
  const starts = stage.jobs.map(job => job.startedAt).filter((value): value is string => Boolean(value)).sort()
  const finishes = stage.jobs.map(job => job.finishedAt).filter((value): value is string => Boolean(value)).sort()
  const isDone = stage.jobs.every(job => job.finishedAt || job.status === 'skipped' || job.status === 'manual')
  return {
    startedAt: stage.startedAt ?? starts[0],
    finishedAt: stage.finishedAt ?? (isDone ? finishes.at(-1) : undefined),
  }
}

export function elapsed(startedAt: string | undefined, finishedAt: string | undefined, now: number): string {
  if (!startedAt) return '—'
  const end = finishedAt ? Date.parse(finishedAt) : now
  const seconds = Math.max(0, Math.round((end - Date.parse(startedAt)) / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`
}

export const STATUS_ICON: Record<PipelineStatus, string> = {
  success: '✔',
  failed: '✘',
  running: '◐',
  pending: '○',
  canceled: '⊘',
  skipped: '»',
  manual: '▶',
}

export const STATUS_COLOR: Record<PipelineStatus, string> = {
  success: 'green',
  failed: 'red',
  running: 'yellow',
  pending: 'gray',
  canceled: 'gray',
  skipped: 'gray',
  manual: 'cyan',
}
