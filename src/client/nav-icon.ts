import * as React from 'react'

/**
 * The glyph DSH shows beside the "远程控制" settings section.
 *
 * DSH 0.2.2 gave the settings navigation an icon seat addressed by section id
 * (`settings.section.icon`), so the row no longer needs the label-search and
 * CSS-swap trick earlier releases required. The shell supplies `size` and
 * `active`; the outline is drawn in `currentColor` so both the resting and the
 * selected colour come from the shell.
 */
export function PhoneIcon(props: { size?: number; active?: boolean }): React.ReactElement {
  const size = props.size ?? 16
  return React.createElement('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false },
    React.createElement('rect', { width: 14, height: 20, x: 5, y: 2, rx: 2, ry: 2 }),
    React.createElement('path', { d: 'M12 18h.01' }))
}
