#!/usr/bin/env node
/**
 * Rewrites the marker sections of README.md with live GitHub data.
 *
 * Run by .github/workflows/readme.yml (every 6 hours, on push to main, and
 * manually via "Run workflow"); that workflow commits generated README assets
 * back to the repository afterwards.
 *
 * Reads:  README.md, the GitHub REST API
 * Writes: README.md (in place), assets/repo-links/*.svg
 * Env:    GITHUB_TOKEN — injected automatically inside Actions. Optional
 *         locally, but without it the API allows only 60 requests/hour.
 *
 * Any failed API call other than a featured-repo lookup throws, which fails
 * the workflow on purpose: a half-written README is worse than a stale one.
 *
 * Run it locally from the repository root with:
 *   GITHUB_TOKEN=ghp_xxx node scripts/build-readme.mjs
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// --- Configuration --------------------------------------------------------
// Baked in when the package was exported from the Profile README Studio.
// To change the username or the featured list, re-export from the Studio
// instead of editing these lines, so README and script stay in sync.
const USER = "zhiyingzzhou";
const FEATURED = ["ZhongAnTech/zarm","Kishanjvaghela/react-native-cardview","zhiyingzzhou/renewlet","zhiyingzzhou/LyRN"];
const token = process.env.GITHUB_TOKEN;
const LINK_ASSET_DIR = "assets/repo-links";
const LINK_ASSET_BASE = `https://raw.githubusercontent.com/${USER}/${USER}/main/${LINK_ASSET_DIR}`;
const LINK_COLOR = "#d2451e";
const LINK_FONT_SIZE = 16;
const LINK_HEIGHT = 20;
const linkAssets = new Map();

/**
 * Calls the GitHub REST API and returns the parsed JSON body.
 *
 * @param {string} path API path starting with a slash, e.g. "/users/octocat".
 * @returns {Promise<any>} Parsed response body.
 * @throws {Error} On any non-2xx response, with status and body included so
 *   the Actions log shows the reason (404 renamed repo, 403 rate limit, …).
 */
const gh = async (path) => {
  const res = await fetch("https://api.github.com" + path, {
    headers: {
      accept: "application/vnd.github+json",
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
  });
  if (!res.ok) throw new Error(path + " -> " + res.status + " " + (await res.text()));
  return res.json();
};

/**
 * Thousands separator. The locale is pinned to en-US so the committed README
 * never changes just because a runner reports a different default locale.
 *
 * @param {number} n
 * @returns {string}
 */
const num = (n) => n.toLocaleString("en-US");

/**
 * Escapes text for HTML attributes and SVG text nodes.
 *
 * @param {string} s
 * @returns {string}
 */
const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * Makes a filesystem-safe, stable slug for generated SVG link assets.
 *
 * @param {string} s
 * @returns {string}
 */
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repo";

/**
 * Estimates rendered SVG text width. The SVG over-allocates slightly so GitHub's
 * system-font fallback cannot clip long repository names.
 *
 * @param {string} text
 * @returns {number}
 */
const textWidth = (text) => {
  const units = [...text].reduce((sum, ch) => {
    if (/[\u3000-\u9fff]/u.test(ch)) return sum + 1;
    if (/[MW@#%&]/.test(ch)) return sum + 0.95;
    if (/[A-Z]/.test(ch)) return sum + 0.72;
    if (/[ilI1`'.,:;|!]/.test(ch)) return sum + 0.32;
    if (/[-/\\]/.test(ch)) return sum + 0.42;
    return sum + 0.58;
  }, 0);
  return Math.ceil(units * LINK_FONT_SIZE + 8);
};

/**
 * Registers a generated orange SVG text link and returns the README HTML that
 * keeps the visible link orange while preserving the real repository click.
 *
 * @param {any} repo GitHub repository object.
 * @param {string} label Visible repository label.
 * @returns {string}
 */
const repoLink = (repo, label) => {
  const width = textWidth(label);
  const file = `${slug(repo.full_name)}-${slug(label)}.svg`;
  const safeLabel = esc(label);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${LINK_HEIGHT}" viewBox="0 0 ${width} ${LINK_HEIGHT}" role="img" aria-label="${safeLabel}">
  <title>${safeLabel}</title>
  <text x="0" y="16" fill="${LINK_COLOR}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif" font-size="${LINK_FONT_SIZE}" font-weight="700">${safeLabel}</text>
</svg>
`;
  linkAssets.set(file, svg);
  return `<a href="${esc(repo.html_url)}"><img alt="${safeLabel}" src="${LINK_ASSET_BASE}/${file}" width="${width}" height="${LINK_HEIGHT}"></a>`;
};

/**
 * Writes the generated orange link SVGs and removes stale SVGs from previous
 * refreshes so renamed or removed repositories do not leave dead assets behind.
 */
const writeLinkAssets = () => {
  mkdirSync(LINK_ASSET_DIR, { recursive: true });
  for (const file of readdirSync(LINK_ASSET_DIR)) {
    if (file.endsWith(".svg")) rmSync(join(LINK_ASSET_DIR, file));
  }
  for (const [file, svg] of linkAssets) {
    writeFileSync(join(LINK_ASSET_DIR, file), svg);
  }
};

// --- Every repository the user owns ---------------------------------------
// sort=pushed puts the most recently touched repos first, which is exactly the
// order the "recently updated" list needs. Five pages (500 repos) is the cap:
// enough headroom for this account, and it bounds the workflow runtime.
const allRepos = [];
for (let page = 1; page <= 5; page++) {
  const batch = await gh(`/users/${USER}/repos?per_page=100&page=${page}&type=owner&sort=pushed`);
  allRepos.push(...batch);
  if (batch.length < 100) break;
}
// Forks are excluded: their stars belong to the original author, so counting
// them would inflate the totals.
const own = allRepos.filter((r) => !r.fork);
const totalStars = own.reduce((s, r) => s + r.stargazers_count, 0);
const user = await gh(`/users/${USER}`);

// --- The featured repositories, fetched one by one ------------------------
// They are full "owner/name" slugs rather than entries picked out of own[],
// because the selection includes repositories owned by other organisations
// (e.g. ZhongAnTech/zarm). A single failure only warns: one repo being renamed,
// deleted or made private must not block the whole refresh.
const featured = [];
for (const slug of FEATURED) {
  try {
    featured.push(await gh("/repos/" + slug));
  } catch (err) {
    console.warn("skipping " + slug + ": " + err.message);
  }
}

/**
 * Makes a repository description safe for a Markdown table cell: a literal "|"
 * inside a description would end the cell early and break the table layout.
 *
 * @param {string|null|undefined} s
 * @returns {string}
 */
const clean = (s) => (s ?? "").replace(/\|/g, "/").trim();

// Body for <!--START_SECTION:projects--> — the "Selected work" table.
const projectRows = [
  "| Project | What it is | Stars | Language | Updated |",
  "| --- | --- | --: | --- | --- |",
  ...featured.map(
    (r) => {
      const label = r.owner.login.toLowerCase() === USER.toLowerCase() ? r.name : r.full_name;
      return `| ${repoLink(r, label)} | ${clean(r.description)} | ${num(r.stargazers_count)} | ${
        r.language ?? "—"
      } | ${r.pushed_at.slice(0, 10)} |`;
    },
  ),
].join("\n");

// Body for <!--START_SECTION:recent--> — the five most recently pushed repos.
const recent = own
  .slice(0, 5)
  .map(
    (r) =>
      `- ${repoLink(r, r.name)} — ${clean(r.description) || "no description"} · ${r.pushed_at.slice(0, 10)}`,
  )
  .join("\n");

// Body for <!--START_SECTION:summary--> — the one-line headline stats.
const summary = `\`${num(totalStars)}\` stars earned · \`${num(own.length)}\` public repos · \`${num(
  user.followers,
)}\` followers · refreshed \`${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC\``;

// --- Write the sections back into README.md -------------------------------
let md = readFileSync("README.md", "utf8");

/**
 * Replaces everything between <!--START_SECTION:key--> and
 * <!--END_SECTION:key--> with the given body.
 *
 * Missing markers are skipped silently by design: deleting a block from
 * README.md is a supported way to drop a section, and it must not fail the run.
 *
 * @param {string} key Marker name, e.g. "projects".
 * @param {string} body Markdown to place between the markers.
 */
const replace = (key, body) => {
  const re = new RegExp(`(<!--START_SECTION:${key}-->)[\\s\\S]*?(<!--END_SECTION:${key}-->)`);
  if (!re.test(md)) return;
  md = md.replace(re, `$1\n${body}\n$2`);
};
replace("projects", projectRows);
replace("recent", recent);
replace("summary", summary);
writeLinkAssets();
writeFileSync("README.md", md);
console.log("README refreshed:", totalStars, "stars across", own.length, "repos");

// Adding a new auto-updated section takes three steps:
//   1. put a <!--START_SECTION:x--> / <!--END_SECTION:x--> pair in README.md
//   2. build the Markdown string for it above
//   3. add one replace("x", ...) call here
