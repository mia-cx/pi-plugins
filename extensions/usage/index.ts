/**
 * `/usage`: usage limits for the selected model, or for CLIProxyAPI auth files.
 *
 *   /usage           every account that can serve the selected model
 *   /usage <query>   CPA auth files whose name, account or provider contains <query>
 *   /usage all       every CPA auth file
 *
 * In the TUI it also refreshes usage for the selected model after each run and
 * emits it on `pi.events` (USAGE_EVENT) for the statusline.
 */
import type { Api, Model } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent'
import { Box, Text } from '@earendil-works/pi-tui'
import { Cpa } from './cpa.ts'
import { DIRECT_PROVIDERS, directTransport, PROBES } from './probes.ts'
import { bar, USAGE_EVENT, type UsageEvent, type UsageReport, until, usageColor } from './report.ts'

const ENTRY_TYPE = 'mia-usage'
const AUTO_REFRESH_MS = 60_000
const BAR_CELLS = 12

interface UsageEntry {
	title: string
	reports: UsageReport[]
}

export default function usage(pi: ExtensionAPI) {
	const cpa = Cpa.load()
	let lastRefresh = { model: '', at: 0 }

	async function reportsForModel(model: Model<Api>, ctx: ExtensionContext): Promise<UsageReport[]> {
		const proxy = await cpa
		if (proxy?.serves(model.baseUrl)) {
			const auths = (await proxy.auths()).filter((auth) => !auth.disabled)
			const serving = await Promise.all(
				auths.map(async (auth) => ((await proxy.models(auth)).includes(model.id) ? auth : undefined))
			)
			const matches = serving.filter((auth) => auth !== undefined)
			if (matches.length) return Promise.all(matches.map((auth) => proxy.report(auth, model.id)))
			// API-key providers (openai-compatibility) have no auth file and no quota to read.
			return [{ source: model.provider, provider: model.provider, windows: [], status: 'API key, no quota to read' }]
		}
		const upstream = DIRECT_PROVIDERS[model.provider]
		if (!upstream) throw new Error(`No usage source for provider ${model.provider}`)
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
		if (!auth.ok) throw new Error(`${model.provider}: ${auth.error}`)
		if (!auth.apiKey) throw new Error(`${model.provider}: no token`)
		const result = await PROBES[upstream](directTransport(auth.apiKey), model.id)
		return [{ source: model.provider, provider: upstream, ...result }]
	}

	async function reportsForQuery(query: string): Promise<UsageReport[]> {
		const proxy = await cpa
		if (!proxy) throw new Error('No CLIProxyAPI configured: set ~/.config/cpa/url and ~/.config/cpa/management-key')
		const needle = query.toLowerCase()
		const auths = (await proxy.auths()).filter(
			(auth) =>
				needle === 'all' ||
				[auth.name, auth.provider, auth.label, auth.email].some((field) => field?.toLowerCase().includes(needle))
		)
		if (!auths.length) throw new Error(`No CPA auth file matches "${query}"`)
		return Promise.all(auths.map((auth) => proxy.report(auth)))
	}

	async function refresh(ctx: ExtensionContext, force = false) {
		const model = ctx.model
		if (!model) return
		const key = `${model.provider}/${model.id}`
		if (!force && lastRefresh.model === key && Date.now() - lastRefresh.at < AUTO_REFRESH_MS) return
		lastRefresh = { model: key, at: Date.now() }
		const reports = await reportsForModel(model, ctx).catch((error: Error): UsageReport[] => [
			{ source: model.provider, provider: model.provider, windows: [], error: error.message }
		])
		pi.events.emit(USAGE_EVENT, { model: key, reports, at: Date.now() } satisfies UsageEvent)
		return reports
	}

	pi.registerEntryRenderer<UsageEntry>(ENTRY_TYPE, (entry, _options, theme) => {
		if (!entry.data) return undefined
		const box = new Box(1, 1, (text) => theme.bg('customMessageBg', text))
		box.addChild(new Text(formatEntry(entry.data, theme).join('\n'), 0, 0))
		return box
	})

	pi.registerCommand('usage', {
		description: 'Usage limits for the selected model, or /usage <auth|provider|all> for CLIProxyAPI accounts',
		getArgumentCompletions: async (prefix) => {
			const proxy = await cpa
			if (!proxy) return null
			const auths = await proxy.auths().catch(() => [])
			const values = ['all', ...new Set(auths.flatMap((auth) => [auth.provider, auth.name]))]
			const items = values.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }))
			return items.length ? items : null
		},
		handler: async (args, ctx) => {
			const query = args.trim()
			try {
				const entry: UsageEntry = query
					? { title: `CLIProxyAPI · ${query}`, reports: await reportsForQuery(query) }
					: {
							title: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : 'no model',
							reports: (await refresh(ctx, true)) ?? []
						}
				if (ctx.mode === 'tui') pi.appendEntry(ENTRY_TYPE, entry)
				else ctx.ui.notify(formatEntry(entry).join('\n'), 'info')
			} catch (error) {
				ctx.ui.notify(`/usage: ${(error as Error).message}`, 'error')
			}
		}
	})

	const autoRefresh = (_event: unknown, ctx: ExtensionContext) => {
		if (ctx.mode === 'tui') void refresh(ctx)
	}
	pi.on('session_start', autoRefresh)
	pi.on('model_select', autoRefresh)
	pi.on('agent_settled', autoRefresh)
}

type Paint = (color: 'accent' | 'muted' | 'dim' | 'success' | 'warning' | 'error', text: string) => string

function formatEntry({ title, reports }: UsageEntry, theme?: Theme): string[] {
	const paint: Paint = theme ? (color, text) => theme.fg(color, text) : (_color, text) => text
	const lines = [theme ? theme.bold(paint('accent', title)) : title]
	const labelWidth = Math.max(0, ...reports.flatMap((report) => report.windows.map((window) => window.label.length)))
	for (const report of reports) {
		const heading = [report.provider, report.account, report.plan].filter(Boolean).join(' · ')
		const flag = report.error ?? report.status
		lines.push('', paint('muted', heading) + (flag ? `  ${paint(report.error ? 'error' : 'warning', flag)}` : ''))
		if (report.details?.length) lines.push(`  ${paint('dim', report.details.join(' · '))}`)
		for (const window of report.windows) {
			const color = usageColor(window.usedPercent)
			const percent = `${Math.round(window.usedPercent)}%`.padStart(4)
			const reset = window.resetsAt ? paint('dim', `  resets in ${until(window.resetsAt)}`) : ''
			lines.push(
				`  ${window.label.padEnd(labelWidth)}  ${paint(color, bar(window.usedPercent, BAR_CELLS))} ${paint(color, percent)}${reset}`
			)
		}
	}
	return lines
}
