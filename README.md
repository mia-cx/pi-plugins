# pi-plugins

<a href="https://0rwx.com">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://0rwx.com/static/AI-W-dark.svg">
    <img alt="AI:W" src="https://0rwx.com/static/AI-W-light.svg" height="48">
  </picture>
</a>

Plugins for the [pi](https://pi.dev) coding agent, in one package.

| Plugin | What it does |
|---|---|
| `optmem` | Loads your [OptMem](https://github.com/VictorTaelin/OptMem) memory into every new session, so the model starts awake. |
| `usage` | `/usage` shows the usage limits of whatever serves the selected model. Reads [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) accounts, plus pi's own `openai-codex` and `anthropic` logins. |
| `statusline` | A two-line footer: folder, branch, model, thinking level, usage limits, context and cost. |
| `nightshade` | A dark theme in pink, sky blue and lilac. |

## Install

```sh
pi install git:github.com/mia-cx/pi-plugins
```

Pick the theme in `/settings`, or set `"theme": "nightshade"` in `~/.pi/agent/settings.json`.

To load only some plugins, use the object form in `settings.json`:

```json
{ "source": "git:github.com/mia-cx/pi-plugins", "extensions": ["extensions/usage/index.ts"] }
```

## `/usage`

| Command | Shows |
|---|---|
| `/usage` | Every account that can serve the selected model |
| `/usage <query>` | CLIProxyAPI auth files whose name, account or provider contains the query |
| `/usage all` | Every CLIProxyAPI auth file |

For CLIProxyAPI, write the server URL and its management key to `~/.config/cpa/url` and `~/.config/cpa/management-key`, or set `CPA_URL` and `CPA_MANAGEMENT_KEY`. The key is only ever sent to that URL. A pi provider counts as CLIProxyAPI when its base URL has the same origin.

Usage comes from CLIProxyAPI's quota plugins when one covers the account's provider, such as [cpa-quota](https://github.com/tom2almighty/cpa-quota). Without one, Codex, Claude and Antigravity accounts are read from the provider's own usage API through CLIProxyAPI's `/api-call`.

## `optmem`

Runs `~/.optmem/memo wake` when a session starts and adds the memory to the system prompt, telling the model not to wake again. Set `OPTMEM_MEMO` to use another `memo` path. Recording memories stays with the model.

## Develop

```sh
pnpm install
pnpm check
pi -e .
```
