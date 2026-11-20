/**
 * OptMem, built in: reads the whole memory with `memo wake` when a session
 * starts and puts it in the system prompt, so the model starts awake instead
 * of running the boot steps itself. Recording memories (`memo note`) stays
 * with the model.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

const MEMO = process.env.OPTMEM_MEMO ?? join(homedir(), '.optmem', 'memo')
const WAKE_TIMEOUT_MS = 15_000
const NEXT_PART = /^Not awake yet\. Run: \S+ wake (\d+) (\d+)$/m

const PREAMBLE = `This is your OptMem memory. Pi loaded it with \`${MEMO} wake\` when this session started, so OptMem is already awake: do not run \`memo wake\`. Keep recording memories with \`${MEMO} note\` as your instructions describe.`

export default function optmem(pi: ExtensionAPI) {
	let memory: string | undefined

	pi.on('session_start', async (_event, ctx) => {
		try {
			memory = await wake(pi)
		} catch (error) {
			memory = undefined
			ctx.ui.notify(`OptMem: ${(error as Error).message}`, 'warning')
		}
	})

	pi.on('before_agent_start', (event) => {
		if (memory) event.systemPromptOptions.sections.memory = memory
	})
}

/** Reads every wake part, following each part's footer to the next. */
async function wake(pi: ExtensionAPI): Promise<string> {
	const parts: string[] = []
	let args = ['wake']
	for (;;) {
		const { stdout, stderr, code } = await pi.exec(MEMO, args, { timeout: WAKE_TIMEOUT_MS })
		// `wake` exits 1 when a compression must happen first; the model does it from the printed prompt.
		if (code !== 0 && !stdout) throw new Error(stderr.trim() || `memo wake exited ${code}`)
		const next = stdout.match(NEXT_PART)
		parts.push(stdout.replace(NEXT_PART, '').trim())
		if (!next) break
		args = ['wake', next[1], next[2]]
	}
	return `${PREAMBLE}\n\n${parts.join('\n')}`
}
