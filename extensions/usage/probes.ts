/**
 * Upstream usage APIs, one probe per provider. A probe only describes the HTTP
 * request; a Transport sends it, either directly with pi's own credentials or
 * through CLIProxyAPI's `/api-call`, which substitutes the auth file's token for
 * `$TOKEN$` server-side.
 */
import type { UsageReport, UsageWindow } from './report.ts'

export const TOKEN = '$TOKEN$'

export interface UpstreamRequest {
	method: 'GET' | 'POST'
	url: string
	headers: Record<string, string>
	body?: string
}

export type Transport = (request: UpstreamRequest) => Promise<{ status: number; body: string }>

export type ProbeResult = Pick<UsageReport, 'account' | 'plan' | 'windows' | 'status' | 'details'>

type Probe = (send: Transport, modelId?: string) => Promise<ProbeResult>

async function getJson<T>(send: Transport, request: UpstreamRequest): Promise<T> {
	const { status, body } = await send(request)
	if (status < 200 || status >= 300) throw new Error(`${new URL(request.url).host} answered ${status}`)
	return JSON.parse(body) as T
}

const SECONDS_PER_HOUR = 3600
const HOURS_PER_DAY = 24

/** `18000` → `5h`, `604800` → `7d`. */
function windowLabel(seconds: number): string {
	const hours = seconds / SECONDS_PER_HOUR
	return hours % HOURS_PER_DAY === 0 ? `${hours / HOURS_PER_DAY}d` : `${hours}h`
}

interface CodexWindow {
	used_percent: number
	limit_window_seconds: number
	reset_at: number
}

interface CodexUsage {
	email?: string
	plan_type?: string
	rate_limit?: { limit_reached?: boolean; primary_window?: CodexWindow; secondary_window?: CodexWindow }
}

const codex: Probe = async (send) => {
	const usage = await getJson<CodexUsage>(send, {
		method: 'GET',
		url: 'https://chatgpt.com/backend-api/wham/usage',
		headers: { Authorization: `Bearer ${TOKEN}` }
	})
	const limit = usage.rate_limit
	const windows = [limit?.primary_window, limit?.secondary_window]
		.filter((window) => window !== undefined && window !== null)
		.map((window) => ({
			label: windowLabel(window.limit_window_seconds),
			usedPercent: window.used_percent,
			resetsAt: window.reset_at * 1000
		}))
	return {
		account: usage.email,
		plan: usage.plan_type,
		windows,
		status: limit?.limit_reached ? 'limit reached' : undefined
	}
}

interface ClaudeWindow {
	utilization: number
	resets_at: string | null
}

const CLAUDE_WINDOWS = {
	five_hour: '5h',
	seven_day: '7d',
	seven_day_opus: '7d opus',
	seven_day_sonnet: '7d sonnet'
} as const

type ClaudeUsage = Partial<Record<keyof typeof CLAUDE_WINDOWS, ClaudeWindow | null>>

const claude: Probe = async (send) => {
	const usage = await getJson<ClaudeUsage>(send, {
		method: 'GET',
		url: 'https://api.anthropic.com/api/oauth/usage',
		headers: { Authorization: `Bearer ${TOKEN}`, 'anthropic-beta': 'oauth-2025-04-20' }
	})
	const windows = Object.entries(CLAUDE_WINDOWS).flatMap(([key, label]): UsageWindow[] => {
		const window = usage[key as keyof typeof CLAUDE_WINDOWS]
		if (!window) return []
		return [
			{
				label,
				usedPercent: window.utilization,
				resetsAt: window.resets_at ? Date.parse(window.resets_at) : undefined
			}
		]
	})
	return { windows }
}

interface AntigravityModels {
	models?: Record<string, { displayName?: string; quotaInfo?: { remainingFraction?: number; resetTime?: string } }>
}

/** Cloud Code answers 403 to clients that don't identify as Antigravity. */
const ANTIGRAVITY_USER_AGENT = 'antigravity/1.11.5'

/** Per-model quotas. With a model id, only that model's quota. */
const antigravity: Probe = async (send, modelId) => {
	const { models = {} } = await getJson<AntigravityModels>(send, {
		method: 'POST',
		url: 'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
		headers: {
			Authorization: `Bearer ${TOKEN}`,
			'Content-Type': 'application/json',
			'User-Agent': ANTIGRAVITY_USER_AGENT
		},
		body: '{}'
	})
	const entries = modelId && models[modelId] ? [[modelId, models[modelId]] as const] : Object.entries(models)
	const windows = new Map<string, UsageWindow>()
	for (const [id, model] of entries) {
		// Internal helpers (tab completion, chat_*) carry a quota but never a reset time.
		if (!model.quotaInfo?.resetTime) continue
		const label = model.displayName ?? id
		// Antigravity leaves out remainingFraction once a quota is spent.
		const usedPercent = (1 - (model.quotaInfo.remainingFraction ?? 0)) * 100
		if ((windows.get(label)?.usedPercent ?? -1) >= usedPercent) continue
		windows.set(label, { label, usedPercent, resetsAt: Date.parse(model.quotaInfo.resetTime) })
	}
	return { windows: [...windows.values()].sort((a, b) => b.usedPercent - a.usedPercent) }
}

/** Probes by upstream provider, keyed the way CLIProxyAPI names auth providers. */
export const PROBES: Record<string, Probe> = { codex, claude, antigravity }

/** pi's own providers whose credentials work against an upstream usage API. */
export const DIRECT_PROVIDERS: Record<string, keyof typeof PROBES> = {
	'openai-codex': 'codex',
	anthropic: 'claude'
}

/** Sends a probe straight upstream with a token pi already holds. */
export function directTransport(token: string): Transport {
	return async ({ method, url, headers, body }) => {
		const response = await fetch(url, {
			method,
			body,
			headers: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, value.replace(TOKEN, token)])),
			signal: AbortSignal.timeout(15_000)
		})
		return { status: response.status, body: await response.text() }
	}
}
