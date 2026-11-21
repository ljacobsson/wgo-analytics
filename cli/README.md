# wgo-analytics-cli

Command line for [WGO](https://github.com/ljacobsson/wgo-analytics), the self-hosted product analytics and
observability backend on AWS. The CLI covers everything WGO's MCP server offers: traffic, errors, failed requests,
session recordings, goals, retention, releases, traces, logs, metrics, uptime and triggers. Each MCP tool is a
command.

It's built for AI agents that can run shell commands (Claude Code, Codex, Cursor…). An MCP client loads every
tool's description and schema into the agent's context in every session. With the CLI, the agent reads a
one-line-per-command list (`wgo --help`) and asks for a command's options only when it uses that command. It can
also cut results down to the fields it needs, and get rows as TSV instead of JSON.

Requires Node.js 20 or later, and a WGO instance with MCP enabled (`MCP_ENABLED=true`, the default).

## Install and sign in

```sh
npm install -g wgo-analytics-cli
wgo login --url https://wgo.example.com
```

`login` opens Cognito's sign-in page in your browser. Sign in with your WGO account. Use the dashboard's
address (the `McpUrl` stack output without `/mcp` works too). The server becomes the default for later commands.

Sign-in uses Cognito's MCP authorization, the same way MCP clients do:

1. The CLI registers itself as an OAuth client (dynamic client registration). It does this once per server.
2. You sign in with authorization code + PKCE through a callback on `http://localhost`.
3. The access token is bound to the server's `/mcp` URL.

Tokens are stored in `~/.config/wgo/credentials.json` (mode 0600). They refresh automatically for 30 days, then
`wgo login` again.

**No browser on this machine** (SSH, container): run `wgo login --no-browser` and open the printed address on
any device. After you sign in, that browser ends up on an `http://localhost…/callback?code=…` page that doesn't
load. Paste that address into the terminal.

```sh
wgo status          # server, account, default project
wgo logout          # revokes the refresh token
```

## Use

```sh
wgo --help                          # all commands of your server
wgo guide                           # how the commands fit together
wgo use "My shop"                   # default project (by name or id); or -p <project> per command
wgo list-errors --range 24h --fields message,count,sessions
wgo top-pages --range 7d --format tsv
wgo explain-change --metric events --where '[{"field":"type","op":"eq","value":"error"}]'
wgo create-goal --name "Signed up" --filters '[{"field":"type","op":"eq","value":"pageview"},{"field":"path","op":"eq","value":"/welcome"}]'
wgo find-recordings --did '[{"action":"hover","target":"buy","notClicked":true}]'
```

Options follow each command's input schema (`wgo <command> --help`):

| Type | Example |
| --- | --- |
| text, number | `--range 24h`, `--limit 20` |
| true/false | `--errors-only`, `--no-enabled` |
| list of text | `--files a.js.map --files b.js.map` |
| anything else | JSON: `--filters '[{"field":"path","op":"eq","value":"/"}]'` |
| all at once | `--args '{"range":"1h"}'`, `--args @args.json`, `--args -` (stdin) |

Output is JSON on stdout. It's compact when piped and indented in a terminal (`--pretty` forces indentation).

- `--fields a,b.c` keeps only those fields of each row. Rows are the result itself if it's a list, or its first
  list of objects, e.g. `projects` of `list-projects`. Fields that name a top-level value select that instead,
  e.g. `get-overview --fields totals`.
- `--format tsv` prints the rows as tab-separated values with one header line. Other top-level values come
  first as `# key: value` lines.

Errors go to stderr. The exit status is 1 when a command fails and 2 for invalid usage.

## For AI agents

Add something like this to your `CLAUDE.md` or `AGENTS.md`:

```md
Product analytics, errors, traces and logs for this app are in WGO. Use the `wgo` CLI (already signed in):
run `wgo guide` once, `wgo <command> --help` for options, and prefer `--fields` and `--format tsv` to keep results small.
```

Sign in yourself first (`wgo login`). An agent can't complete the browser sign-in.

## Settings

| | |
| --- | --- |
| `--url`, `WGO_URL` | Server, instead of the one from `wgo login` |
| `-p`, `--project`, `WGO_PROJECT` | Project, instead of the one from `wgo use` |
| `WGO_CONFIG_DIR` | Where config and credentials live (default `$XDG_CONFIG_HOME/wgo` or `~/.config/wgo`, `%APPDATA%\wgo` on Windows) |
| `WGO_DEBUG=1` | Stack traces on errors |

The command list is cached for a day. Run `wgo tools --refresh` after upgrading the server to see new commands.

A local dev server (`npm run dev` in `backend/`) needs no sign-in: `wgo login --url localhost:8787`.

## Develop

```sh
cd cli && npm install && npm test
node bin/wgo.mjs --help
```

Publishing: bump `version` in `package.json`, then `npm publish` from `cli/`. That runs the tests and copies the
repository's LICENSE into the package.
