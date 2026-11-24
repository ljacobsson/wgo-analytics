# wgo-sourcemaps

Uploads source maps to [WGO](https://github.com/ljacobsson/wgo-analytics), the self-hosted product analytics and
observability backend on AWS. With the maps uploaded, JavaScript error stacks in the dashboard (and the MCP server)
show your original file names, lines and function names.

No dependencies. Requires Node.js 18 or later.

## Usage

1. Build with hidden source maps, so the bundles don't point to them: Vite `build: { sourcemap: 'hidden' }`,
   webpack `devtool: 'hidden-source-map'`.
2. Set `release` in `wgo.init()` (or `data-release`) to something unique per deploy, such as the git sha.
3. After the build, upload the maps:

```sh
npx wgo-sourcemaps --endpoint https://wgo.example.com --key uk_... --release 1.4.0 dist/
```

| Option | Environment variable | |
| --- | --- | --- |
| `--endpoint <url>` | `WGO_ENDPOINT` | Your WGO address |
| `--key <uk_...>` | `WGO_UPLOAD_KEY` | The project's upload key, from Settings, Source maps (owners only). Keep it as a CI secret, it is not the write key |
| `--release <name>` | `WGO_RELEASE` | The same value you pass to `wgo.init({ release })` |

Every `*.js.map` file under the given files and folders is uploaded (`node_modules` is skipped). The command exits
with 1 if any upload fails, and with 2 on bad arguments.

Maps are matched by the script's file name (`index-abc123.js`) and the release. Maps uploaded without a release are
the fallback. Don't deploy the `.map` files to your site.

## In CI

```yaml
# GitHub Actions
- run: npm run build
- run: npx wgo-sourcemaps dist/
  env:
    WGO_ENDPOINT: https://wgo.example.com
    WGO_UPLOAD_KEY: ${{ secrets.WGO_UPLOAD_KEY }}
    WGO_RELEASE: ${{ github.sha }}
```

## License

MIT
