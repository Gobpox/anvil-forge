# anvil-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Gobpox/anvil-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Gobpox/anvil-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Anvil Forge is a GitHub-compatible git forge written from scratch in
dependency-free TypeScript for Node.js. One in-memory, content-addressed git
object store backs all four surfaces, so state is always consistent across
them:

- **Git smart HTTP** — protocol v0 and v2: `info/refs` advertisements,
  `ls-refs`, fetch (including shallow clones and `deepen`), and receive-pack
  with fast-forward enforcement and per-ref status reports. Packfiles are
  written delta-free and cached per object set; pushed packs are read back
  with full ofs-delta/ref-delta support.
- **REST API v3** — repositories, contents (files and directories), branches
  and git refs, commits, labels, issues with comments, and pull requests with
  file diffs and squash merges, all with GitHub's status codes, JSON error
  shape, request-id headers and `Link` pagination.
- **GraphQL** — a small purpose-built parser and executor: viewer,
  repository, issue and pull-request queries, cursor-paginated connections,
  node ids, introspection, batched requests, and the create/close/merge
  mutations, kept in lock-step with the REST surface.
- **MCP** — a stateless JSON-RPC endpoint speaking both protocol eras
  (`server/discover` and legacy `initialize`) with tools for repositories,
  issues and pull requests that act on the same store.

Everything is deterministic: commits carry a logical clock, so a replayed
scenario produces byte-identical state. No packages, no network, no git
binary — just the Node standard library.

## Run it

```sh
node --experimental-strip-types main.ts
```

The entry binds an ephemeral port, registers it with the trial environment
(`MAKEFUN_ENV_URL`) and serves until the environment says the trial is done.
When `MAKEFUN_SHOP_TOKEN` is set, every surface requires
`Authorization: Bearer <token>`; `/healthz` answers without it.

## Layout

- `main.ts` — the entry ↔ environment lifecycle (bind, register, poll, exit).
- `app.ts` — the HTTP server and the REST router.
- `store.ts` — the unified in-memory store and git object primitives.
- `gitcore.ts` — packfile read/write, pkt-lines, history closures, diffs.
- `gitserver.ts` — the smart-HTTP protocol handlers.
- `forgeops.ts` — domain operations shared by REST, GraphQL and MCP.
- `gql.ts` — the GraphQL parser and executor.
- `mcp.ts` — the MCP JSON-RPC endpoint and its tools.

## License

MIT — see [LICENSE](LICENSE).

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
