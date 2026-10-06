// A reviewr-style diff pane: four diff scopes, file and hunk navigation,
// comments on hunks, and Send, which puts every comment in the prompt box.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DiffFile, FocusRegion, ForgeView, Pipeline, PipelineStage, ReviewComment, Scope, Tab } from '../types'
import {
  STATUS_COLOR,
  STATUS_ICON,
  currentCommand,
  elapsed,
  parseGithubRun,
  parseGitlabPipeline,
  stageSpan,
} from './pipeline'
import { GITHUB_FIELDS, checksColor, parseGithub, parseGitlab } from './forge'
import { STATUS_LETTER, fileTree, formatComments, hunkRows, hunksInView, parseDiff, sortByFolder } from './diff'

const PANE = 'diff-review'
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
// Share of the terminal the docked pane asks for, like reviewr's half split.
const DOCK_SHARE = 0.6
const ROW_BACKGROUND = { add: '#15301f', remove: '#3a1a1d' } as const
const ROW_ACCENT = { add: 'green', remove: 'red' } as const
const REFRESHING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'])

const scope = atom({ plugin: 'diff-review', key: 'scope' } as const, 'uncommitted' as Scope)
const files = atom({ plugin: 'diff-review', key: 'files' } as const, [] as DiffFile[])
const fileIndex = atom({ plugin: 'diff-review', key: 'fileIndex' } as const, 0)
const hunkIndex = atom({ plugin: 'diff-review', key: 'hunkIndex' } as const, 0)
const comments = atom({ plugin: 'diff-review', key: 'comments' } as const, [] as ReviewComment[])
const isSidebarHidden = atom({ plugin: 'diff-review', key: 'isSidebarHidden' } as const, false)
const focusRegion = atom({ plugin: 'diff-review', key: 'focusRegion' } as const, 'diff' as FocusRegion)
const isComposing = atom({ plugin: 'diff-review', key: 'isComposing' } as const, false)
const turnTree = atom({ plugin: 'diff-review', key: 'turnTree' } as const, null as string | null)
const baseLabel = atom({ plugin: 'diff-review', key: 'baseLabel' } as const, '')
const notice = atom({ plugin: 'diff-review', key: 'notice' } as const, '')
const tab = atom({ plugin: 'diff-review', key: 'tab' } as const, 'changes' as Tab)
const forge = atom({ plugin: 'diff-review', key: 'forge' } as const, null as ForgeView | null)
const forgeNotice = atom({ plugin: 'diff-review', key: 'forgeNotice' } as const, '')
const pipeline = atom({ plugin: 'diff-review', key: 'pipeline' } as const, null as Pipeline | null)
const pipelineNotice = atom({ plugin: 'diff-review', key: 'pipelineNotice' } as const, '')
const stageIndex = atom({ plugin: 'diff-review', key: 'stageIndex' } as const, 0)
const zoomedStage = atom({ plugin: 'diff-review', key: 'zoomedStage' } as const, null as number | null)
const now = atom({ plugin: 'diff-review', key: 'now' } as const, 0)
const pollGeneration = atom({ plugin: 'diff-review', key: 'pollGeneration' } as const, 0)

const TICK_MS = 2_000
const TICKS_PER_FETCH = 5

const SCOPE_LABELS: Record<Scope, string> = {
  uncommitted: 'uncommitted',
  branch: 'branch',
  turn: 'last turn',
  commit: 'last commit',
}

async function git($: EngineInterface, args: string[], env?: Record<string, string>): Promise<string> {
  const result = await $.process.run(['git', ...args], { env, timeoutMs: 20_000 })
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`)
  return result.stdout
}

// The working tree as a tree object, untracked files included and .gitignore
// respected, built in a scratch index seeded from the real one so unchanged
// files are not rehashed.
async function snapshotTree($: EngineInterface): Promise<string> {
  const gitPath = async (name: string) =>
    (await git($, ['rev-parse', '--path-format=absolute', '--git-path', name])).trim()
  const scratchIndex = await gitPath('diff-review.index')
  await $.process.run(['cp', await gitPath('index'), scratchIndex])
  const env = { GIT_INDEX_FILE: scratchIndex }
  await git($, ['add', '-A'], env)
  return (await git($, ['write-tree'], env)).trim()
}

async function defaultBase($: EngineInterface): Promise<string> {
  const remoteHead = await $.process.run(['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  return remoteHead.exitCode === 0 ? remoteHead.stdout.trim() : 'main'
}

async function headOrEmpty($: EngineInterface): Promise<string> {
  const head = await $.process.run(['git', 'rev-parse', '--verify', '--quiet', 'HEAD'])
  return head.exitCode === 0 ? head.stdout.trim() : EMPTY_TREE
}

async function diffRange($: EngineInterface, current: Scope): Promise<{ from: string; to: string; label: string } | string> {
  switch (current) {
    case 'uncommitted':
      return { from: await headOrEmpty($), to: await snapshotTree($), label: 'vs HEAD' }
    case 'branch': {
      const base = await defaultBase($)
      const mergeBase = (await git($, ['merge-base', base, 'HEAD'])).trim()
      return { from: mergeBase, to: await snapshotTree($), label: `vs ${base}` }
    }
    case 'turn': {
      const start = await read($, turnTree)
      if (!start) return 'No turn has started since the pane loaded.'
      return { from: start, to: await snapshotTree($), label: 'since the last turn started' }
    }
    case 'commit':
      return { from: 'HEAD~1', to: 'HEAD', label: 'HEAD~1..HEAD' }
  }
}

async function refresh($: EngineInterface): Promise<void> {
  try {
    const range = await diffRange($, await read($, scope))
    if (typeof range === 'string') {
      await update($, files, () => [])
      await update($, notice, () => range)
      return
    }
    const output = await git($, ['diff', '--no-color', '--no-ext-diff', '-M', range.from, range.to])
    const parsed = sortByFolder(parseDiff(output))
    await update($, files, () => parsed)
    await update($, baseLabel, () => range.label)
    await update($, notice, () => '')
    await update($, fileIndex, index => Math.min(index, Math.max(0, parsed.length - 1)))
    await update($, hunkIndex, () => 0)
  } catch (error) {
    await update($, notice, () => (error instanceof Error ? error.message : String(error)))
  }
}

async function selectScope($: EngineInterface, next: Scope): Promise<void> {
  await update($, scope, () => next)
  await update($, fileIndex, () => 0)
  await refresh($)
}

async function selectFile($: EngineInterface, index: number): Promise<void> {
  await update($, fileIndex, () => index)
  await update($, hunkIndex, () => 0)
}

function shortPath(path: string, width: number): string {
  return path.length <= width ? path : `…${path.slice(path.length - width + 1)}`
}

async function isGithubRepo($: EngineInterface): Promise<boolean> {
  const remotes = (await git($, ['remote'])).split('\n').filter(Boolean)
  const remote = ['upstream', 'origin'].find(name => remotes.includes(name)) ?? remotes[0]
  if (!remote) throw new Error('This repo has no remote.')
  return (await git($, ['remote', 'get-url', remote])).trim().includes('github.com')
}

async function runJson($: EngineInterface, argv: string[]): Promise<string> {
  const result = await $.process.run(argv, { timeoutMs: 30_000 })
  if (result.exitCode !== 0) throw new Error(result.stderr.trim().split('\n')[0] || `${argv[0]} failed`)
  return result.stdout
}

// The branch's latest pipeline (GitLab) or workflow run (GitHub). A GitLab
// job's command is read from its log: running jobs on every fetch, finished
// ones once, for the stage selected or zoomed into.
async function loadPipeline($: EngineInterface): Promise<void> {
  try {
    const loaded = (await isGithubRepo($)) ? await loadGithubRun($) : await loadGitlabPipeline($)
    await update($, pipeline, () => loaded)
    await update($, pipelineNotice, () => '')
    await update($, stageIndex, index => Math.min(index, Math.max(0, loaded.stages.length - 1)))
  } catch (error) {
    await update($, pipelineNotice, () => (error instanceof Error ? error.message : String(error)))
  }
}

async function loadGitlabPipeline($: EngineInterface): Promise<Pipeline> {
  const loaded = parseGitlabPipeline(await runJson($, ['glab', 'ci', 'get', '--output', 'json']))
  const previous = await read($, pipeline)
  const zoomed = await read($, zoomedStage)
  const selected = await read($, stageIndex)
  const known = new Map(previous?.stages.flatMap(stage => stage.jobs).map(job => [job.id, job]))

  await Promise.all(
    loaded.stages.flatMap((stage, stageAt) =>
      stage.jobs.map(async job => {
        const cached = known.get(job.id)
        const isFinished = job.status !== 'running'
        if (isFinished && cached?.command && cached.status === job.status) {
          job.command = cached.command
          job.output = cached.output
          return
        }
        if (job.status !== 'running' && stageAt !== zoomed && stageAt !== selected) return
        if (job.status === 'pending' || job.status === 'skipped' || job.status === 'manual') return
        const trace = await $.process.run(['glab', 'api', `projects/:id/jobs/${job.id}/trace`], { timeoutMs: 30_000 })
        if (trace.exitCode === 0) Object.assign(job, currentCommand(trace.stdout))
      }),
    ),
  )
  return loaded
}

async function loadGithubRun($: EngineInterface): Promise<Pipeline> {
  const branch = (await git($, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  const runs = JSON.parse(await runJson($, ['gh', 'run', 'list', '--branch', branch, '--limit', '1', '--json', 'databaseId']))
  const runId = runs[0]?.databaseId
  if (!runId) throw new Error(`No workflow runs for ${branch}.`)
  const fields = 'databaseId,workflowName,status,conclusion,url,headBranch,createdAt,updatedAt,jobs'
  return parseGithubRun(await runJson($, ['gh', 'run', 'view', String(runId), '--json', fields]))
}

// Ticks the clock while the Pipeline tab is shown, so running times count up,
// and refetches every few ticks while the pipeline is still going. A newer
// call or a reload (which cancels this loop's sleep) ends it.
async function startPolling($: EngineInterface): Promise<void> {
  const generation = await update($, pollGeneration, value => value + 1)
  let ticks = 0
  try {
    while ((await read($, tab)) === 'pipeline' && (await read($, pollGeneration)) === generation) {
      const current = await read($, pipeline)
      const isActive = !current || current.status === 'running' || current.status === 'pending'
      if (ticks % TICKS_PER_FETCH === 0 && (ticks === 0 || isActive)) await loadPipeline($)
      const time = await $.clock.now()
      await update($, now, () => time)
      ticks += 1
      await $.clock.sleep(TICK_MS)
    }
  } catch {
    // A reload or session end cancels the pending sleep; the loop just stops.
  }
}

async function zoomStage($: EngineInterface, index: number | null): Promise<void> {
  await update($, zoomedStage, () => index)
  if (index !== null) {
    await update($, stageIndex, () => index)
    await loadPipeline($)
  }
}

async function moveStage($: EngineInterface, step: number): Promise<void> {
  const count = (await read($, pipeline))?.stages.length ?? 0
  if (count === 0) return
  await update($, stageIndex, index => Math.max(0, Math.min(count - 1, index + step)))
  await loadPipeline($)
}

// The branch's open MR (GitLab, via glab) or PR (GitHub, via gh), read-only.
async function loadForge($: EngineInterface): Promise<void> {
  await update($, forgeNotice, () => 'Loading…')
  try {
    const isGithub = await isGithubRepo($)

    const argv = isGithub ? ['gh', 'pr', 'view', '--json', GITHUB_FIELDS] : ['glab', 'mr', 'view', '--comments', '--output', 'json']
    const result = await $.process.run(argv, { timeoutMs: 30_000 })
    if (result.exitCode !== 0) {
      const reason = result.stderr.trim().split('\n')[0] || `${argv[0]} failed`
      throw new Error(`No ${isGithub ? 'PR' : 'MR'} for this branch: ${reason}`)
    }
    const view = isGithub ? parseGithub(result.stdout) : parseGitlab(result.stdout)
    await update($, forge, () => view)
    await update($, forgeNotice, () => '')
  } catch (error) {
    await update($, forge, () => null)
    await update($, forgeNotice, () => (error instanceof Error ? error.message : String(error)))
  }
}

async function selectTab($: EngineInterface, next: Tab): Promise<void> {
  await update($, tab, () => next)
  if (next === 'forge' && (await read($, forge)) === null) await loadForge($)
  if (next === 'pipeline') void startPolling($)
}

async function openPane($: EngineInterface, presentation: { isFullscreen: boolean; columns: number }) {
  await refresh($)
  await $.ui.open({
    id: PANE,
    title: 'diff-review',
    focus: true,
    ...(presentation.isFullscreen ? { columns: Math.floor(presentation.columns * DOCK_SHARE) } : {}),
  })
  return { text: 'diff-review pane opened.' }
}

async function toggleRegion($: EngineInterface): Promise<void> {
  const hidden = await read($, isSidebarHidden)
  await update($, focusRegion, region => (region === 'diff' && !hidden ? 'files' : 'diff'))
}

async function moveFile($: EngineInterface, step: number): Promise<void> {
  const count = (await read($, files)).length
  if (count === 0) return
  await update($, fileIndex, index => (index + step + count) % count)
  await update($, hunkIndex, () => 0)
}

// Walks hunks across files, like reviewr's ] and [.
async function moveHunk($: EngineInterface, step: number): Promise<void> {
  const list = await read($, files)
  if (list.length === 0) return
  const fileAt = await read($, fileIndex)
  const hunkAt = (await read($, hunkIndex)) + step
  const hunkCount = list[fileAt]?.hunks.length ?? 0

  if (hunkAt >= 0 && hunkAt < hunkCount) {
    await update($, hunkIndex, () => hunkAt)
    return
  }
  const nextFile = (fileAt + step + list.length) % list.length
  await update($, fileIndex, () => nextFile)
  await update($, hunkIndex, () => (step > 0 ? 0 : Math.max(0, (list[nextFile]?.hunks.length ?? 1) - 1)))
}

async function addComment($: EngineInterface, text: string): Promise<void> {
  await update($, isComposing, () => false)
  if (text.trim().length === 0) return
  const file = (await read($, files))[await read($, fileIndex)]
  const hunk = file?.hunks[await read($, hunkIndex)]
  if (!file || !hunk) return
  const [hunkHeader = '', ...body] = hunk.split('\n')
  const comment: ReviewComment = { path: file.path, hunkHeader, snippet: body.join('\n'), text: text.trim() }
  await update($, comments, list => [...list, comment])
}

async function sendComments($: EngineInterface): Promise<void> {
  const list = await read($, comments)
  if (list.length === 0) {
    $.ui.toast('No comments to send.')
    return
  }
  const filled = await $.prompt.fill({ text: formatComments(list), mode: 'append' })
  if (!filled.isFilled) {
    $.ui.toast('The prompt box is busy; comments kept.')
    return
  }
  await update($, comments, () => [])
  $.ui.toast(`${list.length} comment${list.length === 1 ? '' : 's'} added to the prompt.`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'diff-review', description: 'Open the diff-review pane: changes, MR and pipeline' })
    void refresh($)
    void $.ui.open({ id: PANE, title: 'diff-review' })
    if ((await read($, tab)) === 'pipeline') void startPolling($)
    return next(e)
  })

  on('command.run', { command: 'diff-review' }, async ($, e) => openPane($, e.presentation))

  on('turn.start', async ($, e, next) => {
    try {
      const tree = await snapshotTree($)
      await update($, turnTree, () => tree)
    } catch {
      // Not a git repo, or git failed: the turn scope reports it on refresh.
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (REFRESHING_TOOLS.has(e.tool)) void refresh($)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    void refresh($)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)
    const { Box, Text, Button, Code, Input, Link, Markdown } = $.ui.resolve(e)
    const bodyColumns = e.props.bodyColumns
    const bodyRows = e.props.scroll.bodyRows
    const activeTab = await read($, tab)
    const view = await read($, forge)
    const hasKeys = e.props.isFocused

    const keysIndicator = hasKeys ? (
      <Text color="cyan">⌨ keys here · esc → chat</Text>
    ) : (
      <Text dimColor>ctrl+x tab → keys</Text>
    )

    const tabBar = (
      <Box flexDirection="row" gap={2} marginRight={2}>
        <Button key="tab-changes" plain hotkey="1" dimColor={activeTab !== 'changes'} label="Changes" onPress={() => selectTab($, 'changes')} />
        <Button key="tab-forge" plain hotkey="2" dimColor={activeTab !== 'forge'} label={view?.kind ?? 'MR/PR'} onPress={() => selectTab($, 'forge')} />
        <Button key="tab-pipeline" plain hotkey="3" dimColor={activeTab !== 'pipeline'} label="Pipeline" onPress={() => selectTab($, 'pipeline')} />
      </Box>
    )

    if (activeTab === 'pipeline') {
      const loaded = await read($, pipeline)
      const pipelineMessage = await read($, pipelineNotice)
      const selected = await read($, stageIndex)
      const zoomed = await read($, zoomedStage)
      const clock = (await read($, now)) || (await $.clock.now())
      const boxWidth = Math.max(30, Math.min(bodyColumns - 2, 72))
      const zoomedTo = zoomed === null ? undefined : loaded?.stages[zoomed]

      const arrow = (key: string, label?: string) => (
        <Box key={key} flexDirection="column" alignItems="center" width={boxWidth}>
          <Text dimColor>│</Text>
          <Text color="cyan">▼{label ? <Text dimColor> {label}</Text> : null}</Text>
        </Box>
      )

      // Every box lists its jobs; the selected one also shows each job's
      // command and latest output, which the zoomed view shows too.
      const stageBox = (stage: PipelineStage, index: number, isSelected: boolean) => {
        const span = stageSpan(stage)
        const done = stage.jobs.filter(job => job.status === 'success' || job.status === 'skipped').length
        return (
          <Box
            key={`stage-${index}`}
            flexDirection="column"
            width={boxWidth}
            borderStyle={isSelected ? 'bold' : 'round'}
            borderColor={isSelected ? 'cyan' : STATUS_COLOR[stage.status]}
            paddingX={1}
          >
            <Box flexDirection="row">
              <Text color={STATUS_COLOR[stage.status]}>{STATUS_ICON[stage.status]} </Text>
              <Button key={`stage-open-${index}`} plain label={stage.name} onPress={() => zoomStage($, index)} />
              <Text dimColor>
                {' '}
                · {done}/{stage.jobs.length} done
              </Text>
              <Box flexGrow={1} />
              <Text dimColor>{elapsed(span.startedAt, span.finishedAt, clock)}</Text>
            </Box>
            {stage.jobs.map(job => {
              const isRunning = job.status === 'running'
              const showsCommand = (isSelected || isRunning) && job.command
              return (
                <Box key={`stage-job-${job.id}`} flexDirection="column">
                  <Box flexDirection="row">
                    <Text dimColor>{'  '}</Text>
                    <Text color={STATUS_COLOR[job.status]}>{STATUS_ICON[job.status]} </Text>
                    <Text bold={isRunning}>{job.name}</Text>
                    {job.isAllowedToFail && <Text dimColor> (may fail)</Text>}
                    <Box flexGrow={1} />
                    <Text dimColor>{elapsed(job.startedAt, job.finishedAt, clock)}</Text>
                  </Box>
                  {showsCommand && (
                    <Text color={isRunning ? 'yellow' : undefined} dimColor={!isRunning} wrap="truncate-end">
                      {'    $ '}
                      {job.command}
                    </Text>
                  )}
                  {isSelected && job.output && (
                    <Text dimColor wrap="truncate-end">
                      {'      '}
                      {job.output}
                    </Text>
                  )}
                </Box>
              )
            })}
          </Box>
        )
      }

      const header = (
        <Box flexDirection="row" gap={1}>
          {tabBar}
          {loaded && <Text color={STATUS_COLOR[loaded.status]}>{STATUS_ICON[loaded.status]}</Text>}
          {loaded && <Text bold>{loaded.name}</Text>}
          {loaded && <Text dimColor>{loaded.ref}</Text>}
          <Box flexGrow={1} />
          {loaded && <Text dimColor>{elapsed(loaded.startedAt, loaded.finishedAt, clock)}</Text>}
          {keysIndicator}
        </Box>
      )

      if (loaded && zoomedTo && zoomed !== null) {
        const span = stageSpan(zoomedTo)
        const nextStage = loaded.stages[zoomed + 1]
        return (
          <Box flexDirection="column">
            {header}
            <Box flexDirection="row" gap={1} marginTop={1}>
              <Button key="zoom-back" plain hotkey="h" label="← stages" onPress={() => zoomStage($, null)} />
              <Text color={STATUS_COLOR[zoomedTo.status]}>
                {STATUS_ICON[zoomedTo.status]} {zoomedTo.name}
              </Text>
              <Text dimColor>
                {zoomedTo.status} · {elapsed(span.startedAt, span.finishedAt, clock)} · {zoomedTo.jobs.length} in parallel
              </Text>
            </Box>
            {zoomedTo.jobs.map(job => (
              <Box
                key={`job-${job.id}`}
                flexDirection="column"
                width={boxWidth}
                borderStyle="round"
                borderColor={STATUS_COLOR[job.status]}
                paddingX={1}
              >
                <Box flexDirection="row">
                  <Text color={STATUS_COLOR[job.status]}>{STATUS_ICON[job.status]} </Text>
                  <Text bold>{job.name}</Text>
                  {job.isAllowedToFail && <Text dimColor> (may fail)</Text>}
                  <Box flexGrow={1} />
                  <Text dimColor>{elapsed(job.startedAt, job.finishedAt, clock)}</Text>
                </Box>
                {job.command && (
                  <Text color={job.status === 'running' ? 'yellow' : undefined} dimColor={job.status !== 'running'} wrap="truncate-end">
                    $ {job.command}
                  </Text>
                )}
                {job.output && (
                  <Text dimColor wrap="truncate-end">
                    {job.output}
                  </Text>
                )}
                {!job.command && <Text dimColor>{job.status}</Text>}
              </Box>
            ))}
            {nextStage && arrow('zoom-arrow', 'next')}
            {nextStage && (
              <Box flexDirection="row" width={boxWidth} borderStyle="round" borderDimColor paddingX={1}>
                <Text color={STATUS_COLOR[nextStage.status]}>{STATUS_ICON[nextStage.status]} </Text>
                <Button key="zoom-next" plain hotkey="l" label={nextStage.name} onPress={() => zoomStage($, zoomed + 1)} />
                <Box flexGrow={1} />
                <Text dimColor>{nextStage.status}</Text>
              </Box>
            )}
            <Box gap={1} flexWrap="wrap" marginTop={1}>
              <Button key="pipeline-refresh" plain dimColor hotkey="r" label="refresh" onPress={() => loadPipeline($)} />
              <Button key="pipeline-open" plain dimColor hotkey="o" label="open in browser" onPress={() => void $.process.run(['open', loaded.url])} />
              <Text dimColor>↑↓ scroll</Text>
            </Box>
          </Box>
        )
      }

      return (
        <Box flexDirection="column">
          {header}
          {pipelineMessage && <Text color="red">{pipelineMessage}</Text>}
          {!loaded && !pipelineMessage && <Text dimColor>Loading the pipeline…</Text>}
          {loaded && (
            <Box flexDirection="column" marginTop={1}>
              {loaded.stages.flatMap((stage, index) => [
                ...(index > 0 ? [arrow(`arrow-${index}`)] : []),
                stageBox(stage, index, index === selected),
              ])}
            </Box>
          )}
          <Box gap={1} flexWrap="wrap" marginTop={1}>
            <Button key="stage-down" plain dimColor hotkey="j" label="next stage" onPress={() => moveStage($, 1)} />
            <Button key="stage-up" plain dimColor hotkey="k" label="prev stage" onPress={() => moveStage($, -1)} />
            <Button key="stage-zoom" plain dimColor hotkey="l" label="zoom in" onPress={() => zoomStage($, selected)} />
            <Button key="pipeline-refresh" plain dimColor hotkey="r" label="refresh" onPress={() => loadPipeline($)} />
            {loaded && <Button key="pipeline-open" plain dimColor hotkey="o" label="open in browser" onPress={() => void $.process.run(['open', loaded.url])} />}
          </Box>
        </Box>
      )
    }

    if (activeTab === 'forge') {
      const forgeMessage = await read($, forgeNotice)
      const stateColor = view?.state.includes('open') ? 'green' : view?.state.includes('merged') ? 'magenta' : 'red'
      return (
        <Box flexDirection="column">
          <Box flexDirection="row">
            {tabBar}
            <Box flexGrow={1} />
            {view && <Text dimColor>{view.number} </Text>}
            {keysIndicator}
          </Box>
          {forgeMessage && <Text color={forgeMessage === 'Loading…' ? undefined : 'red'} dimColor={forgeMessage === 'Loading…'}>{forgeMessage}</Text>}
          {view && (
            <Box flexDirection="column">
              <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
                <Text bold>{view.title}</Text>
                <Box flexDirection="row" gap={1}>
                  <Text color={stateColor} bold>{view.state}</Text>
                  <Text dimColor>
                    @{view.author} · {view.target} ← {view.source}
                  </Text>
                </Box>
                <Box flexDirection="row" gap={2}>
                  {view.checks && <Text color={checksColor(view.checks)}>● checks {view.checks}</Text>}
                  {view.mergeStatus && <Text dimColor>merge: {view.mergeStatus.replaceAll('_', ' ')}</Text>}
                </Box>
                <Link href={view.url} label={view.url} />
              </Box>
              <Markdown text={view.description.trim() || '_No description._'} />
              <Box marginTop={1}>
                <Text bold>
                  Comments <Text dimColor>({view.notes.length})</Text>
                </Text>
              </Box>
              {view.notes.map(one => (
                <Box flexDirection="column" marginTop={1} borderStyle="round" borderDimColor paddingX={1}>
                  <Box flexDirection="row" gap={1}>
                    <Text bold>@{one.author}</Text>
                    {one.path && (
                      <Text color="cyan" wrap="truncate-start">
                        {one.path}
                        {one.line ? `:${one.line}` : ''}
                      </Text>
                    )}
                    {one.isResolved !== undefined && (
                      <Text color={one.isResolved ? 'green' : 'yellow'}>{one.isResolved ? 'resolved' : 'unresolved'}</Text>
                    )}
                  </Box>
                  <Markdown text={one.body} />
                </Box>
              ))}
            </Box>
          )}
          <Box gap={1} flexWrap="wrap" marginTop={1}>
            <Button key="forge-refresh" plain dimColor hotkey="r" label="refresh" onPress={() => loadForge($)} />
            {view && <Button key="forge-open" plain dimColor hotkey="o" label="open in browser" onPress={() => void $.process.run(['open', view.url])} />}
            <Text dimColor>↑↓ scroll</Text>
          </Box>
        </Box>
      )
    }

    const list = await read($, files)
    const current = await read($, scope)
    const fileAt = await read($, fileIndex)
    const hunkAt = await read($, hunkIndex)
    const pending = await read($, comments)
    const composing = await read($, isComposing)
    const sidebarHidden = await read($, isSidebarHidden)
    const region = sidebarHidden ? 'diff' : await read($, focusRegion)
    const regionBorder = (name: FocusRegion) => (hasKeys && region === name ? 'cyan' : undefined)
    const label = await read($, baseLabel)
    const message = await read($, notice)

    const file = list[fileAt]
    const added = list.reduce((sum, one) => sum + one.added, 0)
    const removed = list.reduce((sum, one) => sum + one.removed, 0)
    const sidebarWidth = sidebarHidden ? 0 : Math.min(40, Math.max(24, Math.floor(bodyColumns * 0.28)))
    const mainRows = Math.max(6, bodyRows - (composing ? 5 : 3) - (message ? 1 : 0))
    // Inside a round border: two rows of frame, one for the title row.
    const diffRows = mainRows - 3
    const sidebarRows = mainRows - 3

    const tree = fileTree(list)
    const selectedRow = Math.max(0, tree.findIndex(row => row.kind === 'file' && row.index === fileAt))
    const firstRow = Math.max(0, Math.min(selectedRow - Math.floor(sidebarRows / 2), tree.length - sidebarRows))

    const shownRows = file ? hunksInView(file.hunks, hunkAt, diffRows).flatMap(hunkRows) : []
    const lastLine = shownRows.reduce((max, row) => (row.kind === 'header' ? max : Math.max(max, row.oldLine ?? 0, row.newLine ?? 0)), 0)
    const gutterWidth = Math.max(3, String(lastLine).length)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          {tabBar}
          <Text color="yellow" bold>
            [{SCOPE_LABELS[current]}]
          </Text>
          <Text dimColor>{label}</Text>
          <Box flexGrow={1} />
          {pending.length > 0 && <Text color="magenta">{pending.length} comments</Text>}
          <Text dimColor>{list.length} changed</Text>
          <Text color="green">+{added}</Text>
          <Text color="red">-{removed}</Text>
          {keysIndicator}
        </Box>
        {message && <Text color="red" wrap="truncate-end">{message}</Text>}

        <Box flexDirection="row" height={mainRows} overflow="hidden">
          <Box flexDirection="column" flexGrow={1} flexShrink={1} borderStyle="round" borderColor={regionBorder('diff')} borderDimColor={!regionBorder('diff')} overflow="hidden">
            {file ? (
              <Text dimColor wrap="truncate-start">
                {file.path} · hunk {Math.min(hunkAt + 1, file.hunks.length)}/{file.hunks.length}
              </Text>
            ) : (
              <Text dimColor>{message ? '' : 'No changes.'}</Text>
            )}
            {file && file.status === 'binary' && <Text dimColor>Binary file, no diff.</Text>}
            {shownRows.map(row => {
              if (row.kind === 'header') {
                return (
                  <Text color="cyan" dimColor wrap="truncate-end">
                    {row.text}
                  </Text>
                )
              }
              const isChange = row.kind !== 'context'
              const accent = row.kind === 'context' ? undefined : ROW_ACCENT[row.kind]
              const background = row.kind === 'context' ? undefined : ROW_BACKGROUND[row.kind]
              const lineNumber = row.kind === 'remove' ? row.oldLine : row.newLine
              return (
                <Box flexDirection="row" backgroundColor={background}>
                  <Text color={accent}>{isChange ? '▎' : ' '}</Text>
                  <Text color={accent} dimColor={!isChange}>
                    {String(lineNumber ?? '').padStart(gutterWidth)}{' '}
                  </Text>
                  <Code source={row.text.length > 0 ? row.text : ' '} path={file?.path} wrap="truncate-end" />
                </Box>
              )
            })}
          </Box>

          {!sidebarHidden && (
            <Box flexDirection="column" width={sidebarWidth} flexShrink={0} borderStyle="round" borderColor={regionBorder('files')} borderDimColor={!regionBorder('files')} overflow="hidden">
              <Text bold color={regionBorder('files')}>Files</Text>
              {tree.slice(firstRow, firstRow + sidebarRows).map(row => {
                if (row.kind === 'dir') {
                  return (
                    <Text dimColor wrap="truncate-start">
                      ▾ {row.path}
                    </Text>
                  )
                }
                const one = list[row.index]
                if (!one) return null
                const isSelected = row.index === fileAt
                const counts = `${one.added > 0 ? ` +${one.added}` : ''}${one.removed > 0 ? ` -${one.removed}` : ''}`
                const nameWidth = sidebarWidth - 6 - counts.length - (row.isNested ? 2 : 0)
                return (
                  <Box flexDirection="row" backgroundColor={isSelected ? '#3b3f52' : undefined}>
                    <Text color="yellow">{row.isNested ? '  ' : ''}{STATUS_LETTER[one.status]} </Text>
                    <Box flexGrow={1}>
                      <Button key={`file-${row.index}`} plain label={shortPath(row.name, nameWidth)} onPress={() => selectFile($, row.index)} />
                    </Box>
                    <Text color="green">{one.added > 0 ? ` +${one.added}` : ''}</Text>
                    <Text color="red">{one.removed > 0 ? ` -${one.removed}` : ''}</Text>
                  </Box>
                )
              })}
            </Box>
          )}
        </Box>

        {composing && (
          <Input
            key="comment"
            label={`Comment on ${file?.path ?? ''} hunk ${hunkAt + 1}`}
            placeholder="Empty to cancel"
            autoFocus
            onSubmit={text => addComment($, text)}
          />
        )}

        <Box gap={1} flexWrap="wrap">
          <Button key="u" plain dimColor hotkey="u" label="uncommitted" onPress={() => selectScope($, 'uncommitted')} />
          <Button key="b" plain dimColor hotkey="b" label="branch" onPress={() => selectScope($, 'branch')} />
          <Button key="t" plain dimColor hotkey="t" label="turn" onPress={() => selectScope($, 'turn')} />
          <Button key="g" plain dimColor hotkey="g" label="commit" onPress={() => selectScope($, 'commit')} />
          <Button key="f" plain dimColor hotkey="f" label={region === 'diff' ? 'focus files' : 'focus diff'} onPress={() => toggleRegion($)} />
          {region === 'files' ? (
            <Button key="j" plain dimColor hotkey="j" label="file↓" onPress={() => moveFile($, 1)} />
          ) : (
            <Button key="j" plain dimColor hotkey="j" label="hunk↓" onPress={() => moveHunk($, 1)} />
          )}
          {region === 'files' ? (
            <Button key="k" plain dimColor hotkey="k" label="file↑" onPress={() => moveFile($, -1)} />
          ) : (
            <Button key="k" plain dimColor hotkey="k" label="hunk↑" onPress={() => moveHunk($, -1)} />
          )}
          {region === 'files' && <Button key="l" plain dimColor hotkey="l" label="open" onPress={() => update($, focusRegion, () => 'diff')} />}
          <Button key="n" plain dimColor hotkey="n" label="hunk↓" onPress={() => moveHunk($, 1)} />
          <Button key="p" plain dimColor hotkey="p" label="hunk↑" onPress={() => moveHunk($, -1)} />
          <Button key="c" plain dimColor hotkey="c" label="comment" onPress={() => update($, isComposing, () => true)} />
          <Button key="s" plain dimColor hotkey="s" label="send" onPress={() => sendComments($)} />
          <Button key="x" plain dimColor hotkey="x" label="clear" onPress={() => update($, comments, () => [])} />
          <Button key="z" plain dimColor hotkey="z" label="hide files" onPress={async () => {
              await update($, isSidebarHidden, hidden => !hidden)
              await update($, focusRegion, () => 'diff')
            }} />
          <Button key="r" plain dimColor hotkey="r" label="refresh" onPress={() => refresh($)} />
        </Box>
      </Box>
    )
  })
}
