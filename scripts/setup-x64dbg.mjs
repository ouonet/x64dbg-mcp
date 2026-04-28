#!/usr/bin/env node
/**
 * setup-x64dbg — download and unpack the latest x64dbg snapshot
 *
 * Usage:
 *   npm run setup-x64dbg                 # latest release
 *   npm run setup-x64dbg -- --force      # re-download even if already present
 *   npm run setup-x64dbg -- --tag snapshot_2024-09-10_00-00
 *
 * Output: ./x64dbg/  (project-local, gitignored)
 */

import fs from "fs";
import https from "https";
import os from "os";
import path from "path";
import readline from "readline";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const ROOT      = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GITHUB_API = "api.github.com";
const REPO       = "x64dbg/x64dbg";

// ── parse args ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const force = argv.includes("--force");
const tagArg = (() => {
  const i = argv.indexOf("--tag");
  return i !== -1 ? argv[i + 1] : null;
})();
const destArg = (() => {
  const i = argv.indexOf("--dest");
  return i !== -1 ? argv[i + 1] : null;
})();

const DEST    = destArg ? path.resolve(destArg) : path.join(ROOT, "x64dbg");
const TMP_ZIP = path.join(path.dirname(DEST), "x64dbg-snapshot.zip");

const isTTY = process.stdout.isTTY;
const c = {
  ok:   isTTY ? "\x1b[32m" : "",
  fail: isTTY ? "\x1b[31m" : "",
  info: isTTY ? "\x1b[36m" : "",
  dim:  isTTY ? "\x1b[2m"  : "",
  bold: isTTY ? "\x1b[1m"  : "",
  rst:  isTTY ? "\x1b[0m"  : "",
};

const log  = (m) => console.log(m);
const ok   = (m) => log(`  ${c.ok}✔${c.rst}  ${m}`);
const info = (m) => log(`  ${c.info}→${c.rst}  ${m}`);
const fail = (m) => { log(`  ${c.fail}✖${c.rst}  ${m}`); process.exit(1); };

// ── helpers ──────────────────────────────────────────────────────────────────

function httpsGet(options) {
  return new Promise((resolve, reject) => {
    const req = https.get(options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const url = new URL(res.headers.location);
        return resolve(httpsGet({
          hostname: url.hostname,
          path: url.pathname + url.search,
          headers: options.headers,
        }));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
  });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const file = fs.createWriteStream(dest);
    let downloaded = 0;

    function doGet(hostname, path) {
      https.get({ hostname, path, headers: { "User-Agent": "x64dbg-mcp-setup" } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const loc = new URL(res.headers.location);
          return doGet(loc.hostname, loc.pathname + loc.search);
        }
        const total = parseInt(res.headers["content-length"] || "0", 10);
        res.on("data", (chunk) => {
          downloaded += chunk.length;
          if (total && process.stdout.isTTY) {
            const pct = Math.round(downloaded / total * 100);
            process.stdout.write(`\r  ${c.info}↓${c.rst}  ${(downloaded / 1e6).toFixed(1)} MB / ${(total / 1e6).toFixed(1)} MB  (${pct}%)   `);
          }
        });
        res.pipe(file);
        file.on("finish", () => { file.close(); process.stdout.write("\n"); resolve(); });
      }).on("error", reject);
    }

    doGet(parsed.hostname, parsed.pathname + parsed.search);
  });
}

function unzip(zipPath, destDir) {
  // Use PowerShell Expand-Archive (always available on Windows 5+)
  const absZip  = zipPath.replace(/\//g, "\\");
  const absDest = destDir.replace(/\//g, "\\");
  execSync(
    `pwsh -NonInteractive -Command "Expand-Archive -LiteralPath '${absZip}' -DestinationPath '${absDest}' -Force"`,
    { stdio: "inherit" }
  );
}

function writeCommitHash(tag, dir) {
  // Store the tag so future runs can detect "already up to date"
  fs.writeFileSync(path.join(dir, "commithash.txt"), tag + "\n", "utf8");
}

// ── GitHub token resolution ──────────────────────────────────────────────────
// Priority: .env GITHUB_TOKEN → ~/.config/x64dbg-mcp/github_tokens.toml → GH_TOKEN env → prompt

const TOML_PATH = path.join(os.homedir(), ".config", "x64dbg-mcp", "github_tokens.toml");

function readEnvToken() {
  // Same priority chain as config.ts resolveEnvFile
  const candidates = [];
  if (process.env.X64DBG_MCP_CONFIG) candidates.push(process.env.X64DBG_MCP_CONFIG);
  candidates.push(path.join(process.cwd(), ".env"));
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, "x64dbg-mcp", ".env"));
  candidates.push(path.join(ROOT, ".env"));
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    const m = fs.readFileSync(f, "utf8").match(/^GITHUB_TOKEN\s*=\s*(.+)$/m);
    if (m) { const v = m[1].trim().replace(/^"|"$/g, "").replace(/^'|'$/g, ""); if (v) return v; }
  }
  return null;
}

function readTomlToken() {
  if (!fs.existsSync(TOML_PATH)) return null;
  try {
    const m = fs.readFileSync(TOML_PATH, "utf8").match(/^GITHUB_TOKEN\s*=\s*"([^"]+)"/im);
    return m ? m[1] : null;
  } catch { return null; }
}

async function promptForToken() {
  if (!isTTY) return null;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(r => rl.question(q, r));
  const token = (await ask(`  ${c.dim}Enter GitHub Personal Access Token (blank to skip):${c.rst} `)).trim();
  rl.close();
  if (!token) return null;

  const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
  const save = (await new Promise(r => rl2.question(
    `  Save token to ${TOML_PATH}? [Y/n]: `, r))).trim().toLowerCase();
  rl2.close();
  if (save !== "n") {
    fs.mkdirSync(path.dirname(TOML_PATH), { recursive: true });
    fs.writeFileSync(TOML_PATH, `GITHUB_TOKEN = "${token}"\n`, "utf8");
    ok(`Token saved to ${TOML_PATH}`);
  }
  return token;
}

async function resolveGithubToken() {
  const envToken = readEnvToken();
  if (envToken) { info("Using GITHUB_TOKEN from .env"); return envToken; }

  const tomlToken = readTomlToken();
  if (tomlToken) { info(`Using GITHUB_TOKEN from ${TOML_PATH}`); return tomlToken; }

  if (process.env.GH_TOKEN) { info("Using GH_TOKEN from environment"); return process.env.GH_TOKEN; }

  return promptForToken();
}

// ── main ─────────────────────────────────────────────────────────────────────

log(`\n${c.bold}x64dbg setup${c.rst}\n`);

// Already present?
if (fs.existsSync(DEST) && !force) {
  const hash = path.join(DEST, "commithash.txt");
  const ver  = fs.existsSync(hash) ? fs.readFileSync(hash, "utf8").trim() : "(unknown)";
  log(`  ${c.dim}x64dbg already present: ${ver}${c.rst}`);
  log(`  ${c.dim}Use --force to re-download.${c.rst}\n`);
  process.exit(0);
}

// ── GitHub auth token (avoids 60 req/h anonymous rate limit) ─────────────────
const githubToken = await resolveGithubToken();
const authHeaders = githubToken ? { "Authorization": `Bearer ${githubToken}` } : {};

// Resolve tag ──────────────────────────────────────────────────────────────────
let tag = tagArg;
if (!tag) {
  info("Fetching latest release info from GitHub…");
  const { status, body } = await httpsGet({
    hostname: GITHUB_API,
    path: `/repos/${REPO}/releases?per_page=5`,
    headers: {
      "User-Agent": "x64dbg-mcp-setup",
      "Accept": "application/vnd.github+json",
      ...authHeaders,
    },
  });

  if (status !== 200) {
    const hint = destArg
      ? `x64dbg-mcp setup --tag snapshot_YYYY-MM-DD_HH-mm`
      : `npm run setup-x64dbg -- --tag snapshot_YYYY-MM-DD_HH-mm`;
    const tokenHint = githubToken
      ? "\n     Token was used but still got 403 — check token scopes/expiry."
      : "\n     Set GITHUB_TOKEN in .env or run setup again to enter a token.";
    fail(`GitHub API returned HTTP ${status}. If rate-limited, find a tag at:\n     https://github.com/x64dbg/x64dbg/releases\n     then pass it manually: ${hint}${tokenHint}`);
  }

  const releases = JSON.parse(body.toString("utf8"));
  // Find first release that has a zip asset (the snapshot)
  const release = releases.find(r => r.assets?.some(a => a.name.endsWith(".zip")));
  if (!release) fail("No snapshot release found. Check https://github.com/x64dbg/x64dbg/releases");

  tag = release.tag_name;
  const asset = release.assets.find(a => a.name.endsWith(".zip"));
  ok(`Latest release: ${tag}`);

  // Download ───────────────────────────────────────────────────────────────────
  info(`Downloading ${asset.name} (${(asset.size / 1e6).toFixed(1)} MB)…`);
  await download(asset.browser_download_url, TMP_ZIP);
} else {
  // Manual tag: construct URL
  const url = `https://github.com/${REPO}/releases/download/${tag}/${tag}.zip`;
  info(`Downloading tag ${tag}…`);
  await download(url, TMP_ZIP);
}

ok(`Downloaded to ${TMP_ZIP}`);

// Extract ──────────────────────────────────────────────────────────────────────
info("Extracting…");
const TMP_DIR = path.join(path.dirname(DEST), "_x64dbg_extract_tmp");
if (fs.existsSync(TMP_DIR)) fs.rmSync(TMP_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

unzip(TMP_ZIP, TMP_DIR);

// The zip may extract into a subdirectory — find it
const entries = fs.readdirSync(TMP_DIR);
const subDir  = entries.length === 1 && fs.statSync(path.join(TMP_DIR, entries[0])).isDirectory()
  ? path.join(TMP_DIR, entries[0])
  : TMP_DIR;

// Move into place
if (fs.existsSync(DEST)) fs.rmSync(DEST, { recursive: true });
fs.renameSync(subDir, DEST);
fs.rmSync(TMP_DIR, { recursive: true, force: true });
fs.unlinkSync(TMP_ZIP);

// Write version marker
writeCommitHash(tag, DEST);

ok(`Extracted to ${DEST}`);

// Verify ───────────────────────────────────────────────────────────────────────
const x64exe = path.join(DEST, "release", "x64", "x64dbg.exe");
const x32exe = path.join(DEST, "release", "x32", "x32dbg.exe");
if (fs.existsSync(x64exe)) ok(`x64dbg.exe present`);
else log(`  ${c.dim}x64dbg.exe not found at expected path — zip layout may differ${c.rst}`);
if (fs.existsSync(x32exe)) ok(`x32dbg.exe present`);

log(`\n${c.bold}Done.${c.rst} Run ${c.bold}npm run install-plugin${c.rst} to deploy the bridge plugin.\n`);
