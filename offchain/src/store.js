// Durable key-value store for the keeper: files in a GitHub repo branch via the contents API.
// Render's disk is wiped on every restart, so the registry (event tickers + pinned outcome order)
// and the exact evidence bytes settlers attest are written here. A dedicated branch keeps these
// commits off main. Use a fine-grained token with Contents read/write on this repo only.
// No token -> disabled: get() returns null, put() returns false (local-only mode).
const API = "https://api.github.com";

import { createHash } from "node:crypto";

/** Git's blob id for some bytes: the sha GitHub reports for a file with exactly this content. */
export const blobSha = (bytes) => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), Buffer.from(bytes)])).digest("hex");

export function createStore({ token, repo, branch = "keeper-data", base = "main", fetchImpl = globalThis.fetch, retryDelayMs = 1000 } = {}) {
  const enabled = Boolean(token && repo);
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "arra-keeper" };
  const gh = async (method, path, body) => {
    const r = await fetchImpl(`${API}/repos/${repo}${path}`, { method, headers: { ...headers, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : {} };
  };
  const enc = (p) => p.split("/").map(encodeURIComponent).join("/");
  let branchReady = null;
  // One request at a time: every write is a commit on the same branch, and two in flight race the
  // branch ref (GitHub answers 409).
  let queue = Promise.resolve();
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));

  async function ensureBranch() {
    branchReady ??= (async () => {
      if ((await gh("GET", `/git/ref/heads/${branch}`)).status === 200) return;
      const main = await gh("GET", `/git/ref/heads/${base}`);
      if (main.status !== 200) throw new Error(`store: cannot read ${base} (${main.status})`);
      const made = await gh("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha: main.body.object.sha });
      if (made.status !== 201 && made.status !== 422) throw new Error(`store: cannot create ${branch} (${made.status})`);
    })().catch((e) => {
      branchReady = null;
      throw e;
    });
    return branchReady;
  }

  async function stat(path) {
    const r = await gh("GET", `/contents/${enc(path)}?ref=${encodeURIComponent(branch)}`);
    if (r.status === 404) return null;
    if (r.status !== 200) throw new Error(`store: GET ${path} -> ${r.status}`);
    return r.body;
  }

  return {
    enabled,
    get(path) {
      if (!enabled) return Promise.resolve(null);
      return serial(async () => {
        await ensureBranch();
        const f = await stat(path);
        return f ? new Uint8Array(Buffer.from(f.content, "base64")) : null;
      });
    },
    /** Write a file. Returns true when committed, "unchanged" when the branch already has these bytes. */
    put(path, bytes, message) {
      if (!enabled) return Promise.resolve(false);
      return serial(() => putNow(path, bytes, message));
    },
  };

  async function putNow(path, bytes, message) {
      await ensureBranch();
      for (let attempt = 0; attempt < 4; attempt++) {
        const prev = await stat(path);
        if (prev && prev.sha === blobSha(bytes)) return "unchanged";
        const r = await gh("PUT", `/contents/${enc(path)}`, {
          message,
          branch,
          content: Buffer.from(bytes).toString("base64"),
          committer: { name: "Qiao Long", email: "Qiao527@users.noreply.github.com" },
          ...(prev ? { sha: prev.sha } : {}),
        });
        if (r.status === 200 || r.status === 201) return true;
        if (r.status !== 409) throw new Error(`store: PUT ${path} -> ${r.status} ${r.body?.message ?? ""}`);
        await pause(retryDelayMs * (attempt + 1)); // the branch moved under us: re-read and retry
      }
      throw new Error(`store: PUT ${path} kept conflicting`);
  }
}
