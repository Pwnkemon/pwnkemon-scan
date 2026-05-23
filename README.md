# Pwnkemon Scan — GitHub Action

Run a **Pwnkemon** security scan on every pull request. Get findings as
a PR comment, fail the build on serious issues, ship safer code.

> [Pwnkemon](https://pwnkemon.com) is an agentic AI security scanner.
> It runs the same scanners you already know (semgrep, osv-scanner,
> trivy, gitleaks, npm-audit) and adds an LLM triage layer that
> filters noise, marks unreachable findings, and prioritises by
> exploitability. Most "high"-severity dependency CVEs are dev-only
> noise — Pwnkemon tells you which ones actually matter.

## Quick start

1. **Get a Pwnkemon API token.** Sign up at <https://pwnkemon.com>, install the
   GitHub App on the repos you want to scan, then mint a GitHub Action
   token at <https://pwnkemon.com/dashboard/tokens>. These tokens are
   narrowly scoped — they can launch scans and read results, nothing
   else.

2. **Add it to your repo secrets** as `PWNKEMON_API_TOKEN`.
   (Settings → Secrets and variables → Actions → New repository secret.)

3. **Drop the Action into your workflow:**

   ```yaml
   # .github/workflows/pwnkemon.yml
   name: Pwnkemon Security Scan
   on:
     pull_request:
   permissions:
     pull-requests: write   # so we can post the findings comment
     contents: read
   jobs:
     scan:
       runs-on: ubuntu-latest
       steps:
         - uses: Pwnkemon/pwnkemon-scan@v1
           with:
             api-token: ${{ secrets.PWNKEMON_API_TOKEN }}
   ```

That's it. On the next PR you'll get a comment like:

> 🛡️ **Pwnkemon Scan**
> 🟠 2 high · 🟡 3 medium · 🔵 1 low
>
> | Severity | Finding |
> |---|---|
> | 🟠 high | Private key exposed in git history (tests/test_verify.py) |
> | 🟡 medium | … |
>
> [View full report →](https://pwnkemon.com/dashboard/scans/…)

The build **fails** by default if any `high` or `critical` finding lands —
configurable via `fail-on`.

## How it works (and why this isn't another wrapper Action)

The Action **does not run scanners on your GitHub runner**. It POSTs to
Pwnkemon's API, which runs the scan in an isolated, ephemeral container
on a dedicated host that holds no customer secrets. Your CI minutes
don't pay for scanner runtime; your runner's secrets never see the
scanner code. See the [security model](https://pwnkemon.com/security)
for details.

## Inputs

| Name | Required | Default | Description |
|---|---|---|---|
| `api-token` | **yes** | — | Pwnkemon API token (`pt_action_*` kind). Store in repo secrets. |
| `tier` | no | `standard` | `quick` (1 credit, fastest), `standard` (full LLM triage), or `deep` (10 credits, exhaustive). |
| `fail-on` | no | `high` | Severity floor that fails the build: `critical`, `high`, `medium`, `low`, or `none`. |
| `comment-pr` | no | `true` | Post (or update in-place) a comment on the PR. Needs `pull-requests: write` permission. |
| `comment-on-clean` | no | `true` | When `comment-pr: true` and the scan finds nothing, still post a "✅ no findings" comment. |
| `wait-for-completion` | no | `true` | Block the workflow until the scan finishes. Set `false` to launch async (won't gate deploys). |
| `timeout-minutes` | no | `30` | Maximum time to wait for the scan to finish. |
| `pwnkemon-api-base` | no | `https://pwnkemon.com` | Override for self-hosted / staging. |

## Outputs

| Name | Description |
|---|---|
| `scan-id` | The Pwnkemon scan UUID — pass to other steps for cross-reference. |
| `report-url` | Direct link to the full report in the Pwnkemon dashboard. |
| `finding-count` | Total number of confirmed (post-triage) findings. |
| `status` | Final scan status: `completed`, `failed`, `cancelled`, `timeout`, or `queued`. |

## Common configurations

### Block deploys only on criticals

```yaml
- uses: Pwnkemon/pwnkemon-scan@v1
  with:
    api-token: ${{ secrets.PWNKEMON_API_TOKEN }}
    fail-on: critical
```

### Async (fire-and-forget) on push to main, blocking on PRs

```yaml
on:
  push:
    branches: [main]
  pull_request:
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: Pwnkemon/pwnkemon-scan@v1
        with:
          api-token: ${{ secrets.PWNKEMON_API_TOKEN }}
          wait-for-completion: ${{ github.event_name == 'pull_request' }}
```

### Deep scan on release, standard everywhere else

```yaml
- uses: Pwnkemon/pwnkemon-scan@v1
  with:
    api-token: ${{ secrets.PWNKEMON_API_TOKEN }}
    tier: ${{ github.event_name == 'release' && 'deep' || 'standard' }}
```

## Permissions

The default workflow `GITHUB_TOKEN` works as long as you grant
`pull-requests: write` — needed to post the findings comment. If you
set `comment-pr: false`, only `contents: read` is needed.

## Troubleshooting

- **`401 Invalid API token`** — the `PWNKEMON_API_TOKEN` secret is
  wrong, expired, or revoked. Mint a fresh one at
  <https://pwnkemon.com/dashboard/tokens>.
- **`402 Insufficient credits`** — your plan's credit balance is too
  low for the scan tier. Upgrade or pick a cheaper tier.
- **`403` on the scan launch** — the GitHub App isn't installed on this
  repo. Visit <https://github.com/settings/installations>, find the
  Pwnkemon App, and add the repository.
- **Action doesn't post a PR comment** — your workflow probably doesn't
  grant `pull-requests: write`. Add `permissions: { pull-requests:
  write }` at the workflow level.

## Pricing & credits

Each scan consumes Pwnkemon credits based on tier. See
<https://pwnkemon.com/pricing> for current rates and free tier.

## License

MIT.
