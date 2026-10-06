export type Scope = 'uncommitted' | 'branch' | 'turn' | 'commit'

export type DiffFile = {
  path: string
  status: 'added' | 'deleted' | 'modified' | 'renamed' | 'binary'
  added: number
  removed: number
  hunks: string[]
}

export type ReviewComment = {
  path: string
  hunkHeader: string
  snippet: string
  text: string
}

export type Tab = 'changes' | 'forge' | 'pipeline'

export type FocusRegion = 'diff' | 'files'

export type PipelineStatus = 'success' | 'failed' | 'running' | 'pending' | 'canceled' | 'skipped' | 'manual'

export type PipelineJob = {
  id: string
  name: string
  status: PipelineStatus
  startedAt?: string
  finishedAt?: string
  isAllowedToFail: boolean
  command?: string
  output?: string
}

export type PipelineStage = {
  name: string
  status: PipelineStatus
  jobs: PipelineJob[]
  current?: string
  startedAt?: string
  finishedAt?: string
}

export type Pipeline = {
  id: string
  name: string
  status: PipelineStatus
  url: string
  ref: string
  startedAt?: string
  finishedAt?: string
  stages: PipelineStage[]
}

export type ForgeNote = {
  author: string
  body: string
  createdAt: string
  path?: string
  line?: number
  isResolved?: boolean
}

export type ForgeView = {
  kind: 'MR' | 'PR'
  number: string
  title: string
  state: string
  url: string
  author: string
  source: string
  target: string
  checks?: string
  mergeStatus?: string
  description: string
  notes: ForgeNote[]
}

declare module 'claude-code' {
  interface PluginState {
    'diff-review': {
      scope: Scope
      files: DiffFile[]
      fileIndex: number
      hunkIndex: number
      comments: ReviewComment[]
      isComposing: boolean
      isSidebarHidden: boolean
      focusRegion: FocusRegion
      turnTree: string | null
      baseLabel: string
      notice: string
      tab: Tab
      forge: ForgeView | null
      forgeNotice: string
      pipeline: Pipeline | null
      pipelineNotice: string
      stageIndex: number
      zoomedStage: number | null
      now: number
      pollGeneration: number
    }
  }
}
