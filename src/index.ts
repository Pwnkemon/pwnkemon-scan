/**
 * Pwnkemon Scan — GitHub Action entrypoint.
 *
 * What this does (and only this):
 *   1. Read inputs from action.yml.
 *   2. POST /api/scans to launch a code scan on Pwnkemon, authenticated
 *      with the pt_action_* token supplied by the user.
 *   3. Poll GET /api/scans/{id} until terminal.
 *   4. Render findings into a CI-log summary, a job-summary markdown,
 *      and (optionally) a PR comment that updates in place.
 *   5. Exit non-zero when findings cross the configured `fail-on`
 *      severity floor.
 *
 * What this is NOT:
 *   - The Action does not run scanners locally. It hands the work to
 *     Pwnkemon's isolated execution host (R-4). The GitHub runner just
 *     waits and reports.
 */

import * as core from "@actions/core";
import * as github from "@actions/github";

type Severity = "critical" | "high" | "medium" | "low" | "info" | "unknown";
const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];

// fail-on accepts the severities AND the literal "none" (never fail).
type FailOn = Severity | "none";

interface Finding {
  severity: string;
  title: string;
  description?: string;
  evidence?: string;
  recommendation?: string;
}

interface ScanResult {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  results?: Array<{ findings?: Finding[] }>;
}

// ─── Input parsing & validation ─────────────────────────────────────

function parseBool(raw: string, fallback: boolean): boolean {
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function parseFailOn(raw: string): FailOn {
  const v = (raw || "high").toLowerCase();
  if (v === "none") return "none";
  if (SEVERITIES.includes(v as Severity)) return v as Severity;
  throw new Error(
    `fail-on must be one of: critical, high, medium, low, info, none (got "${raw}")`,
  );
}

function parseTier(raw: string): "quick" | "standard" | "deep" {
  const v = (raw || "standard").toLowerCase();
  if (v === "quick" || v === "standard" || v === "deep") return v;
  throw new Error(`tier must be quick, standard, or deep (got "${raw}")`);
}

/** Severity rank — higher number = worse. Used to compare a finding
 * against the `fail-on` threshold. */
function severityRank(s: string): number {
  switch (s.toLowerCase()) {
    case "critical":
      return 5;
    case "high":
      return 4;
    case "medium":
      return 3;
    case "low":
      return 2;
    case "info":
      return 1;
    default:
      return 0; // unknown — never trips fail-on
  }
}

// ─── Pwnkemon API client ────────────────────────────────────────────

class PwnkemonClient {
  constructor(
    private readonly base: string,
    private readonly token: string,
  ) {}

  private async req<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const url = `${this.base.replace(/\/$/, "")}${path}`;
    const r = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "User-Agent": "pwnkemon-scan-action/1.0",
      },
    });
    const text = await r.text();
    if (!r.ok) {
      // Surface a readable error. Don't echo the body verbatim if it's
      // suspiciously long (could be an HTML error page from a misrouted
      // request — happens if pwnkemon-api-base is wrong).
      const snippet = text.length > 300 ? text.slice(0, 300) + "…" : text;
      throw new Error(`Pwnkemon API ${r.status} on ${path}: ${snippet}`);
    }
    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  launchScan(payload: {
    scan_type: "code";
    tier: "quick" | "standard" | "deep";
    repo_url: string;
    repo_ref?: string;
    commit_sha?: string;
  }): Promise<ScanResult> {
    return this.req<ScanResult>("/api/scans", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  getScan(id: string): Promise<ScanResult> {
    return this.req<ScanResult>(`/api/scans/${id}`);
  }
}

// ─── Rendering ──────────────────────────────────────────────────────

function severityEmoji(s: string): string {
  switch (s.toLowerCase()) {
    case "critical":
      return "🔴";
    case "high":
      return "🟠";
    case "medium":
      return "🟡";
    case "low":
      return "🔵";
    case "info":
      return "⚪";
    default:
      return "·";
  }
}

function findingsTableMarkdown(findings: Finding[], reportUrl: string): string {
  if (findings.length === 0) {
    return [
      "## 🛡️ Pwnkemon Scan — no findings",
      "",
      "No security issues found in this scan.",
      "",
      `[View full report →](${reportUrl})`,
    ].join("\n");
  }

  // Group + count by severity for the headline.
  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.severity.toLowerCase()] = (counts[f.severity.toLowerCase()] || 0) + 1;
  const headline = SEVERITIES.filter((s) => counts[s])
    .map((s) => `${severityEmoji(s)} ${counts[s]} ${s}`)
    .join(" · ");

  // Sort by severity then alphabetical title.
  const sorted = [...findings].sort((a, b) => {
    const r = severityRank(b.severity) - severityRank(a.severity);
    if (r !== 0) return r;
    return a.title.localeCompare(b.title);
  });

  const rows = sorted.map(
    (f) =>
      `| ${severityEmoji(f.severity)} ${f.severity} | ${escapeCell(f.title)} |`,
  );
  return [
    "## 🛡️ Pwnkemon Scan",
    "",
    headline,
    "",
    "| Severity | Finding |",
    "|---|---|",
    ...rows,
    "",
    `[View full report (with descriptions, evidence, fixes) →](${reportUrl})`,
  ].join("\n");
}

function escapeCell(s: string): string {
  // Cell content can break Markdown tables: collapse newlines, escape
  // pipes. Truncate to keep the PR comment scannable.
  const collapsed = s.replace(/\s+/g, " ").trim();
  const escaped = collapsed.replace(/\|/g, "\\|");
  return escaped.length > 140 ? escaped.slice(0, 137) + "…" : escaped;
}

// ─── PR comment upsert (post-or-edit-in-place) ──────────────────────

// Hidden HTML marker so the next run finds and edits THIS comment
// rather than posting a new one. Standard pattern for status-comment
// Actions (semantic-release, dependabot, etc).
const COMMENT_MARKER = "<!-- pwnkemon-scan-action:comment -->";

async function upsertPRComment(
  body: string,
  token: string,
): Promise<void> {
  const ctx = github.context;
  const pr = ctx.payload.pull_request;
  if (!pr) {
    core.info("Not a pull-request event — skipping PR comment.");
    return;
  }
  const octokit = github.getOctokit(token);
  const { owner, repo } = ctx.repo;
  const issue_number = pr.number;
  const markedBody = `${COMMENT_MARKER}\n${body}`;

  // Find the previous Pwnkemon comment, if any.
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number,
    per_page: 100,
  });
  const existing = comments.find((c) => (c.body || "").includes(COMMENT_MARKER));

  if (existing) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body: markedBody,
    });
    core.info(`Updated existing PR comment #${existing.id}.`);
  } else {
    const { data } = await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number,
      body: markedBody,
    });
    core.info(`Created PR comment #${data.id}.`);
  }
}

// ─── Polling ────────────────────────────────────────────────────────

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

async function pollUntilDone(
  client: PwnkemonClient,
  scanId: string,
  timeoutMs: number,
): Promise<ScanResult> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";
  // Backoff: start at 3s, grow to 10s. Pwnkemon's quick code scans
  // finish in ~30s; standard in 1–3 min. No point hammering the API.
  let intervalMs = 3000;
  while (Date.now() < deadline) {
    const scan = await client.getScan(scanId);
    if (scan.status !== lastStatus) {
      core.info(`Scan ${scanId}: ${scan.status}`);
      lastStatus = scan.status;
    }
    if (TERMINAL.has(scan.status)) return scan;
    await sleep(intervalMs);
    intervalMs = Math.min(intervalMs + 1000, 10000);
  }
  throw new Error(
    `Timed out waiting for scan ${scanId} to complete (status: ${lastStatus}). ` +
      `The scan continues in Pwnkemon's backend — view at the report URL.`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const apiToken = core.getInput("api-token", { required: true });
  if (!apiToken.startsWith("pt_action_") && !apiToken.startsWith("pt_")) {
    // Slight defensive helper — if a user pastes the wrong thing
    // (their Clerk session token, a GitHub PAT) the API would 401 with
    // an opaque error. Catch the common cases up front.
    core.warning(
      "api-token does not look like a Pwnkemon token (expected pt_action_ or pt_ prefix). " +
        "If this fails, double-check the value in your repo secrets.",
    );
  }

  const apiBase = core.getInput("pwnkemon-api-base") || "https://pwnkemon.com";
  const tier = parseTier(core.getInput("tier"));
  const failOn = parseFailOn(core.getInput("fail-on"));
  const commentPR = parseBool(core.getInput("comment-pr"), true);
  const commentOnClean = parseBool(core.getInput("comment-on-clean"), true);
  const waitForCompletion = parseBool(core.getInput("wait-for-completion"), true);
  const timeoutMinutes = parseInt(core.getInput("timeout-minutes") || "30", 10);

  const ctx = github.context;
  const repoUrl = `https://github.com/${ctx.repo.owner}/${ctx.repo.repo}`;

  // Resolve (branch, commit) from the trigger event. The scanner needs
  // a BRANCH for `git clone --branch` AND a COMMIT for the post-clone
  // checkout — sending only the SHA fails because `--branch <sha>` is
  // not valid. For PRs we want the head SHA (the code *in* the PR);
  // for push/workflow_dispatch we use the ref the workflow ran on.
  const pr = ctx.payload.pull_request;
  let branchRef: string | undefined;
  let commitSha: string;
  if (pr) {
    branchRef = pr.head?.ref;        // e.g. "feature/foo"
    commitSha = pr.head?.sha || ctx.sha;
  } else {
    // ctx.ref is the full ref ("refs/heads/main" or "refs/tags/v1").
    // Strip the prefix so we hand the scanner the bare branch/tag name.
    const ref = ctx.ref || "";
    if (ref.startsWith("refs/heads/")) {
      branchRef = ref.substring("refs/heads/".length);
    } else if (ref.startsWith("refs/tags/")) {
      branchRef = ref.substring("refs/tags/".length);
    } else {
      branchRef = undefined; // unknown ref shape — let scanner use default branch
    }
    commitSha = ctx.sha;
  }

  core.info(
    `Launching ${tier} code scan on ${repoUrl} ` +
      `(branch: ${branchRef ?? "default"}, commit: ${commitSha.slice(0, 7)})`,
  );
  const client = new PwnkemonClient(apiBase, apiToken);
  const launched = await client.launchScan({
    scan_type: "code",
    tier,
    repo_url: repoUrl,
    repo_ref: branchRef,
    commit_sha: commitSha,
  });

  core.setOutput("scan-id", launched.id);
  const reportUrl = `${apiBase.replace(/\/$/, "")}/dashboard/scans/${launched.id}`;
  core.setOutput("report-url", reportUrl);
  core.info(`Scan ${launched.id} queued — report URL: ${reportUrl}`);

  if (!waitForCompletion) {
    core.info("wait-for-completion=false; not blocking on scan result.");
    core.setOutput("status", "queued");
    core.setOutput("finding-count", "0");
    return;
  }

  let final: ScanResult;
  try {
    final = await pollUntilDone(client, launched.id, timeoutMinutes * 60 * 1000);
  } catch (err) {
    core.setOutput("status", "timeout");
    core.setOutput("finding-count", "0");
    throw err;
  }

  core.setOutput("status", final.status);
  const findings: Finding[] = (final.results || []).flatMap((r) => r.findings || []);
  core.setOutput("finding-count", String(findings.length));

  // Render report. PR comment + job summary + log lines.
  const md = findingsTableMarkdown(findings, reportUrl);

  // Job summary is always rendered. Costs nothing and shows up on the
  // Actions run page even when no PR.
  await core.summary.addRaw(md).write();

  if (commentPR && (findings.length > 0 || commentOnClean)) {
    // Prefer the explicit `github-token` input (default: ${{ github.token }}
    // in action.yml — works without env: forwarding). Fall back to the
    // process env for older workflows.
    const ghToken =
      core.getInput("github-token") || process.env.GITHUB_TOKEN || "";
    if (!ghToken) {
      core.warning(
        "comment-pr=true but no GitHub token is available; skipping PR comment. " +
          "Pass `github-token: ${{ github.token }}` (default) and add " +
          "`permissions: { pull-requests: write }` to your workflow.",
      );
    } else {
      try {
        await upsertPRComment(md, ghToken);
      } catch (e: any) {
        // PR commenting is a UX nicety; never fail the build over it.
        core.warning(`Failed to post PR comment: ${e?.message || e}`);
      }
    }
  }

  // CI log: per-finding lines so they show as warnings/errors in the
  // PR Checks tab. Group them for collapsibility.
  if (findings.length > 0) {
    core.startGroup(`Findings (${findings.length})`);
    for (const f of findings) {
      const line = `[${f.severity}] ${f.title}`;
      if (severityRank(f.severity) >= severityRank("high")) {
        core.error(line);
      } else {
        core.warning(line);
      }
    }
    core.endGroup();
  } else {
    core.info("No findings.");
  }

  if (final.status !== "completed") {
    throw new Error(
      `Scan ${launched.id} ended with status "${final.status}"` +
        (final.error ? `: ${final.error}` : "") +
        `. See ${reportUrl} for details.`,
    );
  }

  // Pass/fail decision.
  if (failOn === "none") {
    core.info(`fail-on=none — not failing build regardless of severity.`);
    return;
  }
  const floor = severityRank(failOn);
  const offenders = findings.filter((f) => severityRank(f.severity) >= floor);
  if (offenders.length > 0) {
    core.setFailed(
      `Pwnkemon found ${offenders.length} finding(s) at ${failOn} or above. ` +
        `See ${reportUrl}`,
    );
  } else {
    core.info(
      `No findings at ${failOn} or above. ${findings.length} lower-severity finding(s) reported.`,
    );
  }
}

main().catch((err) => {
  // Anything uncaught — a transport error, bad input — fails the build.
  core.setFailed(err?.message ? err.message : String(err));
});
