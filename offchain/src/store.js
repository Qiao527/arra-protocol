// Durable key-value store for the keeper: files in a GitHub repo branch via the contents API.
// Render's disk is wiped on every restart, so the registry (event tickers + pinned outcome order)
// and the exact evidence bytes settlers attest are written here. A dedicated branch keeps these
// commits off main. Use a fine-grained token with Contents read/write on this repo only.
// No token -> disabled: get() returns null, put() returns false (local-only mode).
const API = "https://api.github.com";

export function createStore({ token, repo, branch = "keeper-data", base = "main", fetchImpl = globalThis.fetch } = {}) {
  const enabled = Boolean(token && repo);
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "arra-keeper" };
  const gh = async (method, path, body) => {
    const r = await fetchImpl(`${API}/repos/${repo}${path}`, { method, headers: { ...headers, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : {} };
  };
  const enc = (p) => p.split("/").map(encodeURIComponent).join("/");
  let branchReady = null;

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
    async get(path) {
      if (!enabled) return null;
      await ensureBranch();
      const f = await stat(path);
      return f ? new Uint8Array(Buffer.from(f.content, "base64")) : null;
    },
    async put(path, bytes, message) {
      if (!enabled) return false;
      await ensureBranch();
      for (let attempt = 0; attempt < 2; attempt++) {
        const prev = await stat(path);
        const r = await gh("PUT", `/contents/${enc(path)}`, {
          message,
          branch,
          content: Buffer.from(bytes).toString("base64"),
          committer: { name: "Qiao Long", email: "Qiao527@users.noreply.github.com" },
          ...(prev ? { sha: prev.sha } : {}),
        });
        if (r.status === 200 || r.status === 201) return true;
        if (r.status !== 409) throw new Error(`store: PUT ${path} -> ${r.status} ${r.body?.message ?? ""}`);
      }
      throw new Error(`store: PUT ${path} kept conflicting`);
    },
  };
}
