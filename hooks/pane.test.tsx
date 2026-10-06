import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'diff-review',
  component: 'Pane' as const,
  requestId: 'diff-review',
  viewport: { columns: 160, rows: 40 },
  props: {
    title: 'diff-review',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 36 },
    view: {},
  },
}

// The mount validates each tree against that surface's element table, so a
// tab drawing anything the desktop app lacks fails here.
test('every tab draws on the terminal and in the desktop app', async ($, on) => {
  mock.clock(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: /\[uncommitted\]/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Files' })).toBeDefined()

    await ui.press({ key: 'f' })
    expect(await ui.find({ key: 'l' })).toBeDefined()

    await ui.press({ key: 'tab-forge' })
    expect(await ui.find({ key: 'forge-refresh' })).toBeDefined()

    await ui.press({ key: 'tab-pipeline' })
    expect(await ui.find({ key: 'pipeline-refresh' })).toBeDefined()

    await ui.press({ key: 'tab-changes' })
    await ui.press({ key: 'l' })
    await ui.unmount()
  }
})
