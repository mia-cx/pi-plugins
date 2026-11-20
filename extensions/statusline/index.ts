/**
 * Two-line footer for the TUI.
 *
 *   ~/code/project  ⎇ main                                  extension statuses
 *   ◆ gpt-6.2-sol · high        5h ▰▰▰▱▱ 62% 1h 4m · 7d ▰▱▱▱▱ 16%  ctx 34%
 *
 * Usage comes from the usage extension's USAGE_EVENT on `pi.events`.
 */
import { homedir } from 'node:os'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent'
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import { bar, USAGE_EVENT, type UsageEvent, until, usageColor } from '../usage/report.ts'

const USAGE_BAR_CELLS = 5
const SEPARATOR = ' · '

export default function statusline(pi: ExtensionAPI) {
	let usage: UsageEvent | undefined
	let requestRender = () => {}

	pi.events.on(USAGE_EVENT, (event) => {
		usage = event as UsageEvent
		requestRender()
	})

	pi.on('session_start', (_event, ctx) => {
		if (ctx.mode !== 'tui') return
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender()
			const unsubscribe = footerData.onBranchChange(requestRender)
			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
					const branch = footerData.getGitBranch()
					const location = theme.fg('muted', tildify(ctx.cwd)) + (branch ? theme.fg('dim', `  ⎇ ${branch}`) : '')
					const statuses = [...footerData.getExtensionStatuses().values()].join(SEPARATOR)
					return [
						spread(location, theme.fg('dim', statuses), width),
						spread(modelSegment(ctx, theme, pi.getThinkingLevel()), meters(ctx, theme, usage), width)
					]
				}
			}
		})
	})
}

function modelSegment(ctx: ExtensionContext, theme: Theme, thinking: string): string {
	if (!ctx.model) return theme.fg('dim', 'no model')
	const level = `thinking${thinking[0]?.toUpperCase()}${thinking.slice(1)}` as Parameters<Theme['fg']>[0]
	return `${theme.fg('accent', '◆')} ${theme.bold(ctx.model.id)}${theme.fg('dim', SEPARATOR)}${theme.fg(level, thinking)}`
}

function meters(ctx: ExtensionContext, theme: Theme, usage: UsageEvent | undefined): string {
	const parts: string[] = []
	const model = ctx.model && `${ctx.model.provider}/${ctx.model.id}`
	const reports = usage && usage.model === model ? usage.reports : []
	const report = reports.find((r) => r.windows.length)
	if (report) {
		// The two tightest windows, kept in the provider's order so they don't swap places.
		const tightest = [...report.windows].sort((a, b) => b.usedPercent - a.usedPercent).slice(0, 2)
		const windows = report.windows
			.filter((window) => tightest.includes(window))
			.map((window) => {
				const color = usageColor(window.usedPercent)
				const reset = window.resetsAt && window.usedPercent >= 70 ? theme.fg('dim', ` ${until(window.resetsAt)}`) : ''
				return `${theme.fg('muted', window.label)} ${theme.fg(color, `${bar(window.usedPercent, USAGE_BAR_CELLS)} ${Math.round(window.usedPercent)}%`)}${reset}`
			})
		const others = reports.length - 1
		parts.push(windows.join(theme.fg('dim', SEPARATOR)) + (others > 0 ? theme.fg('dim', ` +${others}`) : ''))
	} else if (reports[0]?.error) {
		parts.push(theme.fg('dim', 'usage ?'))
	}

	const context = ctx.getContextUsage()
	if (context?.percent != null) {
		parts.push(theme.fg('muted', 'ctx ') + theme.fg(usageColor(context.percent), `${Math.round(context.percent)}%`))
	}

	const cost = sessionCost(ctx)
	if (cost > 0) parts.push(theme.fg('dim', `$${cost.toFixed(2)}`))
	return parts.join('  ')
}

function sessionCost(ctx: ExtensionContext): number {
	let total = 0
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === 'message' && entry.message.role === 'assistant') {
			total += (entry.message as AssistantMessage).usage.cost.total
		}
	}
	return total
}

/** Left and right segments on one line, right-aligned, cut to fit. */
function spread(left: string, right: string, width: number): string {
	const gap = width - visibleWidth(left) - visibleWidth(right)
	if (gap < 2) return truncateToWidth(`${left}  ${right}`, width)
	return left + ' '.repeat(gap) + right
}

function tildify(path: string): string {
	const home = homedir()
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path
}
