import type { ForgeNote, ForgeView } from '../types'

type Json = Record<string, any>

// Reads `glab mr view --comments --output json`.
export function parseGitlab(raw: string): ForgeView {
  const mr: Json = JSON.parse(raw)
  const pipeline: Json | null = mr.head_pipeline ?? mr.pipeline ?? null
  const notes: ForgeNote[] = (mr.Discussions ?? [])
    .flatMap((discussion: Json) => discussion.notes ?? [])
    .filter((note: Json) => !note.system)
    .map((note: Json) => ({
      author: note.author?.username ?? 'unknown',
      body: note.body ?? '',
      createdAt: note.created_at ?? '',
      path: note.position?.new_path ?? note.position?.old_path ?? undefined,
      line: note.position?.new_line ?? note.position?.old_line ?? undefined,
      isResolved: note.resolvable ? Boolean(note.resolved) : undefined,
    }))

  return {
    kind: 'MR',
    number: `!${mr.iid}`,
    title: mr.title ?? '',
    state: mr.draft ? `draft · ${mr.state}` : (mr.state ?? ''),
    url: mr.web_url ?? '',
    author: mr.author?.username ?? '',
    source: mr.source_branch ?? '',
    target: mr.target_branch ?? '',
    checks: pipeline?.status,
    mergeStatus: mr.detailed_merge_status ?? undefined,
    description: mr.description ?? '',
    notes,
  }
}

// Reads `gh pr view --json` with the fields in GITHUB_FIELDS.
export const GITHUB_FIELDS = 'number,title,state,isDraft,url,author,headRefName,baseRefName,body,comments,reviews,statusCheckRollup,mergeStateStatus'

export function parseGithub(raw: string): ForgeView {
  const pr: Json = JSON.parse(raw)
  const checks: Json[] = pr.statusCheckRollup ?? []
  const conclusions = checks.map(check => (check.conclusion || check.state || check.status || '').toLowerCase())
  const checkStatus =
    checks.length === 0
      ? undefined
      : conclusions.some(status => status === 'failure' || status === 'error')
        ? 'failed'
        : conclusions.every(status => status === 'success' || status === 'neutral' || status === 'skipped')
          ? 'success'
          : 'running'

  const comments: ForgeNote[] = [...(pr.comments ?? []), ...(pr.reviews ?? [])]
    .filter((note: Json) => (note.body ?? '').trim().length > 0)
    .map((note: Json) => ({
      author: note.author?.login ?? 'unknown',
      body: note.body,
      createdAt: note.createdAt ?? note.submittedAt ?? '',
    }))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))

  return {
    kind: 'PR',
    number: `#${pr.number}`,
    title: pr.title ?? '',
    state: pr.isDraft ? `draft · ${String(pr.state).toLowerCase()}` : String(pr.state ?? '').toLowerCase(),
    url: pr.url ?? '',
    author: pr.author?.login ?? '',
    source: pr.headRefName ?? '',
    target: pr.baseRefName ?? '',
    checks: checkStatus,
    mergeStatus: pr.mergeStateStatus ? String(pr.mergeStateStatus).toLowerCase() : undefined,
    description: pr.body ?? '',
    notes: comments,
  }
}

export function checksColor(status: string | undefined): string | undefined {
  if (!status) return undefined
  if (status === 'success') return 'green'
  if (status === 'failed' || status === 'canceled') return 'red'
  return 'yellow'
}
