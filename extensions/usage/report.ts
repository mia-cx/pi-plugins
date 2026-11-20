/** Shared shape of usage data: the usage extension emits it, the statusline draws it. */

export interface UsageWindow {
	/** Short window name such as `5h`, `7d`, or a model name for per-model quotas. */
	label: string
	usedPercent: number
	/** Epoch milliseconds. */
	resetsAt?: number
}

export interface UsageReport {
	/** What was checked: a CLIProxyAPI auth file name, or a pi provider id. */
	source: string
	/** Upstream provider, such as `codex`, `claude` or `antigravity`. */
	provider: string
	account?: string
	plan?: string
	windows: UsageWindow[]
	/** Account facts beside the windows, such as `Credits 44,818` or `Reset grants 3`. */
	details?: string[]
	/** Account state worth showing, such as `limit reached` or `disabled`. */
	status?: string
	error?: string
}

/** Emitted on `pi.events` whenever usage for the selected model is refreshed. */
export const USAGE_EVENT = 'mia:usage'

export interface UsageEvent {
	/** `provider/modelId` of the model the reports belong to. */
	model: string
	reports: UsageReport[]
	at: number
}

/** Theme colour for a used percentage: calm until a limit gets close. */
export function usageColor(usedPercent: number): 'success' | 'warning' | 'error' {
	if (usedPercent >= 90) return 'error'
	if (usedPercent >= 70) return 'warning'
	return 'success'
}

export function bar(usedPercent: number, cells: number): string {
	const filled = Math.round((Math.min(100, Math.max(0, usedPercent)) / 100) * cells)
	return '▰'.repeat(filled) + '▱'.repeat(cells - filled)
}

const MINUTES_PER_DAY = 1440

/** Time left until `epochMs`: `2d 4h`, `3h 12m`, `9m`. */
export function until(epochMs: number): string {
	const minutes = Math.max(0, Math.round((epochMs - Date.now()) / 60_000))
	const days = Math.floor(minutes / MINUTES_PER_DAY)
	const hours = Math.floor((minutes % MINUTES_PER_DAY) / 60)
	if (days) return `${days}d ${hours}h`
	if (hours) return `${hours}h ${minutes % 60}m`
	return `${minutes}m`
}
