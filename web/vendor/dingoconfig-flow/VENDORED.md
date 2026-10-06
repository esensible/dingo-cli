# Vendored: dingoConfig flow editor

| | |
|---|---|
| source | https://github.com/corygrant/dingoConfig (`git@github.com:corygrant/dingoConfig.git`), directory `web/ClientApp` |
| branch | `development` |
| commit | `1b1f7cfabad5445c3e1ca6b26f306e8adca1872e` ("add react flow", 2026-09-30) — the last commit touching `web/ClientApp`; identical at the branch head `c2056f7` when copied |
| copied | 2026-10-04, with `git archive origin/development:web/ClientApp` |
| author / licence | © 2025 Cory Grant, MIT (`LICENSE`, copied from the repo root) |
| changes | **none** — every file is byte-for-byte the upstream one |

Files: `package.json`, `package-lock.json`, `vite.config.js`, `.gitignore`,
`src/{index.jsx, FlowEditor.jsx, FunctionNode.jsx, LiveEdge.jsx, context.js, valueStore.js, flow.css}`.

## How dingo-web uses it

- **Build:** `web/build.sh flow` (in the dev container) copies these files to
  `$FLOW_BUILD_DIR` (default `/tmp/dingoconfig-flow-build`), runs `npm ci` from
  the upstream lockfile and `vite build --outDir web/flow-editor` with the
  upstream `vite.config.js`. The only difference from upstream's own build is
  the output directory, given on the command line (upstream writes to
  `../wwwroot/js/flow`). Output: `web/flow-editor/flow-editor.js` (ES module,
  ~408 kB, ~128 kB gzip) + `flow-editor.css`, which `index.jsx` loads from next
  to itself.
- **Adapter:** `web/flow.js` passes the editor a fake Blazor `dotnet` object.
  Its `invokeMethodAsync` routes `OnConnect`, `ConfirmRemoveNodes`, `OnDeleted`,
  `OnNodesMoved` and `OnOpenProperties` to `window.api.graphEdit` (the Go port of
  `FlowGraph.cs` in `internal/flow`, in `dingo.wasm`) and pushes the new graph
  back with `setGraph` — what `FlowEditorTab.razor` does in dingoConfig.
- Nothing here needed changing to run outside Blazor.

## Updating

```
git -C ../dingoConfig fetch
git -C ../dingoConfig archive -o /tmp/ca.tar origin/development:web/ClientApp
tar -xf /tmp/ca.tar -C web/vendor/dingoconfig-flow
web/build.sh flow
```

then update the commit above, and check `FlowGraph.cs` / `FlowNodeTypes.cs` for
changes the Go port (`internal/flow`) must follow.
