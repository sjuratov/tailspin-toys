import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";

const execFileAsync = promisify(execFile);
const servers = new Map();
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ISSUE_FIELDS = "number,title,body,labels,assignees,comments,createdAt,updatedAt,url";

async function runGh(args) {
    const { stdout } = await execFileAsync("gh", args, {
        cwd: PROJECT_ROOT,
        maxBuffer: 2_000_000,
    });
    return stdout.trim();
}

async function repositoryName() {
    const output = await runGh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
    if (!output) {
        throw new Error("GitHub repository name was not returned by gh.");
    }
    return output;
}

function normalizeIssue(issue) {
    return {
        number: Number(issue.number),
        title: String(issue.title ?? "Untitled issue"),
        body: String(issue.body ?? "").trim(),
        labels: Array.isArray(issue.labels)
            ? issue.labels
                  .map((label) => (typeof label === "string" ? label : label?.name))
                  .filter(Boolean)
            : [],
        assignees: Array.isArray(issue.assignees)
            ? issue.assignees
                  .map((assignee) => (typeof assignee === "string" ? assignee : assignee?.login))
                  .filter(Boolean)
            : [],
        commentCount: Array.isArray(issue.comments) ? issue.comments.length : Number(issue.comments ?? 0),
        createdAt: String(issue.createdAt ?? ""),
        updatedAt: String(issue.updatedAt ?? ""),
        url: String(issue.url ?? ""),
    };
}

async function listOpenIssues() {
    const repository = await repositoryName();
    const output = await runGh([
        "issue",
        "list",
        "--repo",
        repository,
        "--state",
        "open",
        "--limit",
        "100",
        "--json",
        ISSUE_FIELDS,
    ]);

    if (!output) {
        return { repository, issues: [] };
    }

    const issues = JSON.parse(output);
    if (!Array.isArray(issues)) {
        throw new Error("GitHub returned an unexpected issue list.");
    }

    return { repository, issues: issues.map(normalizeIssue) };
}

function priorityScore(issue) {
    const triageScore = (issue.assignees.length === 0 ? 2 : 0) + (issue.labels.length === 0 ? 1 : 0);
    const updatedAt = Date.parse(issue.updatedAt);
    return {
        triageScore,
        updatedAt: Number.isNaN(updatedAt) ? 0 : updatedAt,
        number: issue.number,
    };
}

function comparePriority(left, right) {
    const leftScore = priorityScore(left);
    const rightScore = priorityScore(right);
    return (
        rightScore.triageScore - leftScore.triageScore ||
        rightScore.updatedAt - leftScore.updatedAt ||
        rightScore.number - leftScore.number
    );
}

function priorityReason(issue) {
    const reasons = [];
    if (issue.assignees.length === 0) {
        reasons.push("it has no assignee");
    }
    if (issue.labels.length === 0) {
        reasons.push("it has not been labeled");
    }

    const updatedAt = Date.parse(issue.updatedAt);
    if (!Number.isNaN(updatedAt) && Date.now() - updatedAt < 7 * 24 * 60 * 60 * 1000) {
        reasons.push("it was updated within the last seven days");
    }

    if (reasons.length === 0) {
        reasons.push("it is among the most recently updated open issues");
    }

    return `Prioritized because ${reasons.join(" and ")}.`;
}

function boardFor(repository, issues) {
    const sortedIssues = [...issues].sort(comparePriority);
    const top = sortedIssues.slice(0, 3).map((issue) => ({
        ...issue,
        priorityReason: priorityReason(issue),
    }));

    return {
        repository,
        total: sortedIssues.length,
        top,
        remainder: sortedIssues.slice(3),
        generatedAt: new Date().toISOString(),
    };
}

async function loadBoard() {
    const { repository, issues } = await listOpenIssues();
    return boardFor(repository, issues);
}

function contextPrompt(issue) {
    const description = issue.body || "No issue description was provided.";
    return [
        `Please start working on GitHub issue #${issue.number}: ${issue.title}.`,
        "",
        `Issue URL: ${issue.url}`,
        "",
        "Issue description:",
        description,
        "",
        "Begin by inspecting the repository and implementing the issue acceptance criteria. Keep the work focused on this issue.",
    ].join("\n");
}

async function addIssueToContext(number) {
    if (!Number.isInteger(number) || number < 1) {
        throw new CanvasError("issue_number_invalid", "A positive integer issue number is required.");
    }

    const { issues } = await listOpenIssues();
    const issue = issues.find((candidate) => candidate.number === number);
    if (!issue) {
        throw new CanvasError("issue_not_found", `Open issue #${number} was not found.`);
    }

    await session.send({ prompt: contextPrompt(issue) });
    return {
        added: true,
        number: issue.number,
        title: issue.title,
    };
}

function readRequestBody(request) {
    return new Promise((resolve, reject) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
            body += chunk;
            if (body.length > 100_000) {
                request.destroy();
                reject(new Error("Request body is too large."));
            }
        });
        request.on("end", () => resolve(body));
        request.on("error", reject);
    });
}

function sendJson(response, status, value) {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(value));
}

function renderHtml() {
    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Issue Triage Board</title>
    <style>
      :root {
        color-scheme: light dark;
        --surface: color-mix(in srgb, var(--background-color-default, #ffffff) 94%, var(--text-color-default, #1f2328) 6%);
        --surface-strong: color-mix(in srgb, var(--background-color-default, #ffffff) 88%, var(--text-color-default, #1f2328) 12%);
        --shadow: color-mix(in srgb, var(--text-color-default, #1f2328) 12%, transparent);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: var(--background-color-default, #ffffff);
        color: var(--text-color-default, #1f2328);
        font: var(--text-body-medium, 14px)/var(--leading-body-medium, 20px) var(--font-sans, system-ui, sans-serif);
      }
      main { max-width: 1120px; margin: 0 auto; padding: clamp(16px, 3vw, 32px); }
      .page-header { border-bottom: 1px solid var(--border-color-default, #d0d7de); margin-bottom: 24px; padding-bottom: 20px; }
      h1 { font-size: clamp(26px, 3vw, 36px); letter-spacing: -0.025em; line-height: 1.1; margin: 0; }
      h2 { font-size: 18px; line-height: 24px; margin: 0; }
      h3 { font-size: 15px; line-height: 21px; margin: 0; }
      p { margin: 0; }
      .lede, .muted { color: var(--text-color-muted, #59636e); }
      .lede { margin-top: 8px; max-width: 75ch; }
      .board-meta { align-items: center; display: flex; flex-wrap: wrap; gap: 8px 14px; margin-top: 12px; }
      .pill { background: var(--surface-strong); border: 1px solid var(--border-color-default, #d0d7de); border-radius: 999px; color: var(--text-color-muted, #59636e); font-size: 12px; padding: 2px 9px; }
      section { margin-top: 28px; }
      .section-heading { align-items: baseline; display: flex; gap: 10px; justify-content: space-between; margin-bottom: 12px; }
      .section-heading p { color: var(--text-color-muted, #59636e); font-size: 12px; }
      .board { display: grid; gap: 14px; grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .remainder { grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); }
      .card { background: var(--surface); border: 1px solid var(--border-color-default, #d0d7de); border-radius: 12px; box-shadow: 0 10px 24px var(--shadow); display: flex; flex-direction: column; min-width: 0; padding: 16px; }
      .top-card { border-color: color-mix(in srgb, var(--true-color-blue, #0969da) 48%, var(--border-color-default, #d0d7de)); }
      .card-header { align-items: start; display: flex; gap: 10px; justify-content: space-between; }
      .issue-link { color: var(--text-color-muted, #59636e); font: 12px var(--font-mono, monospace); text-decoration: none; white-space: nowrap; }
      .issue-link:hover { color: var(--true-color-blue, #0969da); text-decoration: underline; }
      .description { color: var(--text-color-muted, #59636e); display: -webkit-box; line-clamp: 6; margin-top: 11px; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 6; }
      .reason { background: color-mix(in srgb, var(--true-color-blue-muted, #ddf4ff) 62%, transparent); border-left: 3px solid var(--true-color-blue, #0969da); border-radius: 4px; margin-top: 14px; padding: 9px 10px; }
      .reason strong { display: block; font-size: 12px; margin-bottom: 3px; }
      .card-footer { align-items: center; display: flex; gap: 10px; justify-content: space-between; margin-top: auto; padding-top: 16px; }
      .details { color: var(--text-color-muted, #59636e); font-size: 12px; }
      button { appearance: none; background: var(--true-color-blue, #0969da); border: 1px solid var(--true-color-blue, #0969da); border-radius: 7px; color: var(--color-white, #ffffff); cursor: pointer; font: inherit; font-weight: var(--font-weight-semibold, 600); min-height: 34px; padding: 6px 10px; transition: background-color 160ms ease, border-color 160ms ease, transform 160ms ease; }
      button:hover:not(:disabled) { background: color-mix(in srgb, var(--true-color-blue, #0969da) 86%, var(--text-color-default, #1f2328)); border-color: color-mix(in srgb, var(--true-color-blue, #0969da) 86%, var(--text-color-default, #1f2328)); transform: translateY(-1px); }
      button:disabled { cursor: wait; opacity: 0.65; }
      button:focus-visible, a:focus-visible { outline: 2px solid var(--color-focus-outline, #0969da); outline-offset: 2px; }
      .empty { border: 1px dashed var(--border-color-default, #d0d7de); border-radius: 10px; color: var(--text-color-muted, #59636e); padding: 20px; }
      #status { color: var(--text-color-muted, #59636e); min-height: 20px; }
      #status.error { color: var(--true-color-red, #cf222e); }
      @media (max-width: 820px) { .board { grid-template-columns: 1fr; } }
      @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important; } }
    </style>
  </head>
  <body>
    <main>
      <header class="page-header">
        <h1>Issue Triage Board</h1>
        <p class="lede">Open GitHub issues are ranked by unassigned and unlabeled work first, then by most recent activity. Add any issue to the current session to start working on it.</p>
        <div class="board-meta">
          <span id="repository" class="pill">Loading repository...</span>
          <span id="total" class="muted"></span>
          <span id="updated" class="muted"></span>
        </div>
      </header>
      <p id="status" role="status" aria-live="polite">Loading open issues...</p>
      <section aria-labelledby="priority-heading">
        <div class="section-heading">
          <h2 id="priority-heading">Needs attention now</h2>
          <p>Top three likely priorities</p>
        </div>
        <div id="priority-board" class="board"></div>
      </section>
      <section aria-labelledby="remainder-heading">
        <div class="section-heading">
          <h2 id="remainder-heading">More open issues</h2>
          <p>Remaining work</p>
        </div>
        <div id="remainder-board" class="board remainder"></div>
      </section>
    </main>
    <script>
      const repository = document.querySelector("#repository");
      const total = document.querySelector("#total");
      const updated = document.querySelector("#updated");
      const status = document.querySelector("#status");
      const priorityBoard = document.querySelector("#priority-board");
      const remainderBoard = document.querySelector("#remainder-board");

      const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[character]);

      const excerpt = (value) => value || "No issue description was provided.";

      const issueCard = (issue, isTop) => {
        const description = escapeHtml(excerpt(issue.body));
        const labels = issue.labels.length ? issue.labels.join(", ") : "No labels";
        const details = labels + " / " + issue.commentCount + (issue.commentCount === 1 ? " comment" : " comments");
        const reason = isTop ? '<div class="reason"><strong>Why it is prioritized</strong><span>' + escapeHtml(issue.priorityReason) + "</span></div>" : "";
        return '<article class="card' + (isTop ? " top-card" : "") + '" data-testid="' + (isTop ? "top" : "remainder") + '-issue-card-' + issue.number + '">' +
          '<div class="card-header"><h3>' + escapeHtml(issue.title) + '</h3><a class="issue-link" href="' + escapeHtml(issue.url) + '" target="_blank" rel="noreferrer">#' + issue.number + "</a></div>" +
          '<p class="description">' + description + "</p>" +
          reason +
          '<div class="card-footer"><span class="details">' + escapeHtml(details) + "</span>" +
          '<button type="button" data-testid="add-issue-' + issue.number + '" data-issue-number="' + issue.number + '">Add to context</button></div>' +
          "</article>";
      };

      const renderBoard = (board) => {
        repository.textContent = board.repository;
        total.textContent = board.total + (board.total === 1 ? " open issue" : " open issues");
        updated.textContent = "Fetched " + new Date(board.generatedAt).toLocaleTimeString();
        priorityBoard.innerHTML = board.top.length
          ? board.top.map((issue) => issueCard(issue, true)).join("")
          : '<div class="empty">No open issues need attention.</div>';
        remainderBoard.innerHTML = board.remainder.length
          ? board.remainder.map((issue) => issueCard(issue, false)).join("")
          : '<div class="empty">There are no additional open issues.</div>';
      };

      const request = async (path, options) => {
        const response = await fetch(path, options);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Request failed.");
        return data;
      };

      const loadBoard = async () => {
        status.className = "";
        status.textContent = "Loading open issues...";
        try {
          renderBoard(await request("/api/issues"));
          status.textContent = "";
        } catch (error) {
          status.className = "error";
          status.textContent = "Could not load issues: " + error.message;
        }
      };

      document.addEventListener("click", async (event) => {
        const button = event.target.closest("button[data-issue-number]");
        if (!button) return;
        button.disabled = true;
        const originalLabel = button.textContent;
        button.textContent = "Adding...";
        status.className = "";
        status.textContent = "Adding issue #" + button.dataset.issueNumber + " to the current context...";
        try {
          const result = await request("/api/add-to-context", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ number: Number(button.dataset.issueNumber) })
          });
          button.textContent = "Added";
          status.textContent = "Issue #" + result.number + " was added to the current context.";
        } catch (error) {
          button.disabled = false;
          button.textContent = originalLabel;
          status.className = "error";
          status.textContent = "Could not add issue: " + error.message;
        }
      });

      loadBoard();
    </script>
  </body>
</html>`;
}

async function startServer() {
    const server = createServer(async (request, response) => {
        try {
            const url = new URL(request.url ?? "/", "http://127.0.0.1");
            if (url.pathname === "/api/issues" && request.method === "GET") {
                sendJson(response, 200, await loadBoard());
                return;
            }

            if (url.pathname === "/api/add-to-context" && request.method === "POST") {
                const body = JSON.parse(await readRequestBody(request));
                sendJson(response, 200, await addIssueToContext(Number(body.number)));
                return;
            }

            if (url.pathname === "/" && request.method === "GET") {
                response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                response.end(renderHtml());
                return;
            }

            sendJson(response, 404, { error: "Not found." });
        } catch (error) {
            const status = error instanceof CanvasError ? 400 : 500;
            sendJson(response, status, { error: error instanceof Error ? error.message : "The request failed." });
        }
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, url: `http://127.0.0.1:${port}/` };
}

const session = await joinSession({
    canvases: [
        createCanvas({
            id: "issue-triage-board",
            displayName: "Issue Triage Board",
            description: "Triage open GitHub issues and add selected work to the current session.",
            actions: [
                {
                    name: "list_issues",
                    description: "List open GitHub issues ranked by triage priority.",
                    handler: async () => loadBoard(),
                },
                {
                    name: "add_issue_to_context",
                    description: "Add an open GitHub issue to the current session so work can start on it.",
                    inputSchema: {
                        type: "object",
                        properties: { number: { type: "integer", minimum: 1 } },
                        required: ["number"],
                        additionalProperties: false,
                    },
                    handler: async (ctx) => addIssueToContext(Number(ctx.input?.number)),
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer();
                    servers.set(ctx.instanceId, entry);
                }
                return { title: "Issue Triage Board", url: entry.url };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await new Promise((resolve) => entry.server.close(() => resolve()));
                }
            },
        }),
    ],
});
