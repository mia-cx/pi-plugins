/**
 * CLIProxyAPI management client. CPA routes one model to any auth file that
 * serves it, so usage is reported per auth file. Each report comes from CPA's
 * own quota plugins when one covers the provider, otherwise from the provider's
 * usage API called through CPA's `/api-call`.
 *
 * Config: `CPA_URL` and `CPA_MANAGEMENT_KEY`, or the files `~/.config/cpa/url`
 * and `~/.config/cpa/management-key`. The key only ever goes to that URL.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PROBES, type ProbeResult, type Transport } from './probes.ts'
import type { UsageReport } from './report.ts'

const CONFIG_DIR = join(homedir(), '.config', 'cpa')
const REQUEST_TIMEOUT_MS = 20_000
const AUTHS_TTL_MS = 30_000
const MODELS_TTL_MS = 10 * 60_000

export interface CpaAuth {
	name: string
	provider: string
	auth_index: string
	label?: string
	email?: string
	disabled?: boolean
	unavailable?: boolean
	status_message?: string
	cooldowns?: unknown[]
}

/** CPA's normalized quota (`pluginapi.QuotaFetchResponse`). */
interface QuotaPluginResponse {
	subscription?: { plan?: string; tierName?: string }
	summary?: QuotaMetric[]
	groups?: QuotaGroup[]
}

interface QuotaGroup {
	displayName?: string
	buckets?: { window?: string; remainingFraction: number; resetTime?: string }[]
}

interface QuotaMetric {
	label: string
	value: number
	unit?: string
	format?: string
	currency?: string
}

async function setting(env: string, file: string): Promise<string | undefined> {
	const value = process.env[env] ?? (await readFile(join(CONFIG_DIR, file), 'utf8').catch(() => undefined))
	return value?.trim() || undefined
}

/** A short-lived memo of an async value, so bursts of lookups share one request. */
function cached<T>(ttlMs: number, load: () => Promise<T>): () => Promise<T> {
	let value: Promise<T> | undefined
	let loadedAt = 0
	return () => {
		if (!value || Date.now() - loadedAt > ttlMs) {
			loadedAt = Date.now()
			value = load().catch((error) => {
				value = undefined
				throw error
			})
		}
		return value
	}
}

export class Cpa {
	readonly origin: string
	private readonly key: string
	private readonly modelLists = new Map<string, () => Promise<string[]>>()

	private constructor(origin: string, key: string) {
		this.origin = origin
		this.key = key
	}

	/** The configured CPA, or undefined when no URL or management key is set. */
	static async load(): Promise<Cpa | undefined> {
		const [url, key] = await Promise.all([setting('CPA_URL', 'url'), setting('CPA_MANAGEMENT_KEY', 'management-key')])
		return url && key ? new Cpa(new URL(url).origin, key) : undefined
	}

	/** Whether a pi model is served by this CPA. */
	serves(baseUrl: string | undefined): boolean {
		return baseUrl !== undefined && URL.canParse(baseUrl) && new URL(baseUrl).origin === this.origin
	}

	readonly auths = cached(AUTHS_TTL_MS, async () => (await this.request<{ files: CpaAuth[] }>('/auth-files')).files)

	private readonly quotaProviders = cached(AUTHS_TTL_MS, async () => {
		const { providers } = await this.request<{ providers: Record<string, unknown>[] }>('/quota/providers')
		return new Set(providers.flatMap((p) => (p.supported_providers ?? p.supportedProviders ?? []) as string[]))
	})

	/** Model ids an auth file can serve. */
	models(auth: CpaAuth): Promise<string[]> {
		let list = this.modelLists.get(auth.name)
		if (!list) {
			list = cached(MODELS_TTL_MS, async () => {
				const query = new URLSearchParams({ name: auth.name })
				const { models } = await this.request<{ models: { id: string }[] }>(`/auth-files/models?${query}`)
				return models.map((model) => model.id)
			})
			this.modelLists.set(auth.name, list)
		}
		return list()
	}

	/** Usage for one auth file. Failures land in the report, so one bad account never hides the others. */
	async report(auth: CpaAuth, modelId?: string): Promise<UsageReport> {
		const base: UsageReport = {
			source: auth.name,
			provider: auth.provider,
			account: auth.label ?? auth.email,
			windows: [],
			status: accountState(auth)
		}
		try {
			const result = await this.quota(auth, modelId)
			return { ...base, ...result, status: base.status ?? result.status }
		} catch (error) {
			return { ...base, error: (error as Error).message }
		}
	}

	private async quota(auth: CpaAuth, modelId?: string): Promise<ProbeResult> {
		if ((await this.quotaProviders()).has(auth.provider)) {
			const plugin = await this.request<QuotaPluginResponse>('/quota/fetch', { auth_index: auth.auth_index })
			return fromPlugin(plugin)
		}
		const probe = PROBES[auth.provider]
		if (!probe) return { windows: [], status: 'no usage API' }
		return probe(this.transport(auth), modelId)
	}

	private transport(auth: CpaAuth): Transport {
		return async ({ method, url, headers, body }) => {
			const response = await this.request<{ status_code: number; body: string }>('/api-call', {
				auth_index: auth.auth_index,
				method,
				url,
				header: headers,
				data: body ?? ''
			})
			return { status: response.status_code, body: response.body }
		}
	}

	private async request<T>(path: string, body?: unknown): Promise<T> {
		const response = await fetch(`${this.origin}/v0/management${path}`, {
			method: body === undefined ? 'GET' : 'POST',
			body: body === undefined ? undefined : JSON.stringify(body),
			headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		})
		if (!response.ok) throw new Error(`CPA ${path} answered ${response.status}`)
		return (await response.json()) as T
	}
}

function accountState(auth: CpaAuth): string | undefined {
	if (auth.disabled) return 'disabled'
	if (auth.unavailable) return auth.status_message || 'unavailable'
	if (auth.cooldowns?.length) return 'cooling down'
	return undefined
}

const WINDOW_LABELS: Record<string, string> = {
	five_hour: '5h',
	daily: '1d',
	weekly: '7d',
	seven_day: '7d',
	monthly: '30d'
}

/** `five_hour` → `5h`, `seven_day_fable` → `7d fable`. */
function windowLabel(window: string): string {
	return WINDOW_LABELS[window] ?? window.replace(/^seven_day_/, '7d ').replaceAll('_', ' ')
}

function formatMetric({ label, value, unit, format, currency }: QuotaMetric): string {
	const amount =
		format === 'currency' && currency
			? new Intl.NumberFormat('en', { style: 'currency', currency }).format(value)
			: new Intl.NumberFormat('en', { maximumFractionDigits: Math.abs(value) >= 100 ? 0 : 2 }).format(value)
	return `${label} ${amount}${unit ? ` ${unit}` : ''}`
}

function fromPlugin({ subscription, summary = [], groups = [] }: QuotaPluginResponse): ProbeResult {
	// A group name only tells windows apart when there is more than one group.
	const prefix = (group: QuotaGroup) => (groups.length > 1 && group.displayName ? `${group.displayName} ` : '')
	return {
		plan: subscription?.plan ?? subscription?.tierName,
		details: summary.map(formatMetric),
		windows: groups.flatMap((group) =>
			(group.buckets ?? []).map((bucket) => ({
				label: prefix(group) + windowLabel(bucket.window ?? ''),
				usedPercent: (1 - bucket.remainingFraction) * 100,
				resetsAt: bucket.resetTime ? Date.parse(bucket.resetTime) : undefined
			}))
		)
	}
}
