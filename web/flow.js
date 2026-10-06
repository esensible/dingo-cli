// flow.js — the Logic view's adapter around Cory Grant's dingoConfig flow
// editor (React Flow), vendored unmodified at web/vendor/dingoconfig-flow and
// built to web/flow-editor/flow-editor.js (web/build.sh flow).
//
// The editor was written for Blazor: its entry point is
//   create(element, dotnet, graph) → { setGraph, setValues, clearValues,
//     setPropertiesNode, selectNode, fitView, getViewportCenter, dispose }
// and every edit leaves it through dotnet.invokeMethodAsync(name, ...args):
//   OnConnect(source, sourceHandle, target, targetHandle)
//   ConfirmRemoveNodes(ids) → bool        (before React Flow deletes nodes)
//   OnDeleted(nodeIds, [{ target, targetHandle }])
//   OnNodesMoved([{ id, x, y }])
//   OnOpenProperties(id)                  (the gear on a node)
// In dingoConfig the .NET side (FlowEditorTab.razor + FlowGraph.cs) applies the
// edit to the device config and pushes the resulting graph back with setGraph.
// Here a fake `dotnet` does the same through window.api.graphEdit, i.e. the Go
// port of FlowGraph in dingo.wasm (internal/flow), and writes the returned
// config text into the page's editor. The config stays the single source of
// truth; the canvas is always redrawn from it.
//
// This module touches no DOM itself (the page passes callbacks), so it runs
// under Node in the tests.

/**
 * createFlowController({ api, getText, setText, getBase, confirm, onError, onChange, onProps, loadEditor })
 *   api        window.api (graph, graphEdit, graphNode)
 *   getText()  the config text in the page's editor
 *   setText(text, edit)  replace it after an edit changed it
 *   getBase()  which PdmDevices entry (undefined: the file's only PDM)
 *   confirm(message) → Promise<boolean>   the page's inline confirm (never window.confirm)
 *   onError(message)   an edit or a graph failed (the canvas is put back)
 *   onChange(result, edit)  after every successful graph/graphEdit
 *   onProps(id|null)   open / close the properties panel
 *   loadEditor()       → the editor module ({ create }); default: import('./flow-editor/flow-editor.js')
 */
export function createFlowController({
  api, getText, setText, getBase = () => undefined, confirm, onError = () => {}, onChange = () => {}, onProps = () => {},
  loadEditor = () => import('./flow-editor/flow-editor.js'),
}) {
  let editor = null; // the handle create() returned
  let view = null; // the last graph / graphEdit result
  let propsId = null;
  let queue = Promise.resolve();
  // One edit at a time, each on the text the previous one produced.
  const serial = (fn) => { const p = queue.then(fn); queue = p.catch(() => {}); return p; };

  function push(graph) { if (editor && graph) editor.setGraph(graph); }

  function edit(e) {
    return serial(async () => {
      const r = await api.graphEdit(getText(), e, getBase());
      if (!r.ok) {
        onError(r.error);
        push(view?.graph); // React Flow may have removed what it showed; redraw from the config
        return r;
      }
      view = r;
      if (r.changed) setText(r.config, e);
      push(r.graph);
      if (propsId && !r.graph.nodes.some((n) => n.id === propsId)) closeProps();
      onChange(r, e);
      return r;
    });
  }

  /** Redraw from the current config text (after it changed outside the canvas). */
  function refresh() {
    return serial(async () => {
      const r = await api.graph(getText(), getBase());
      if (!r.ok) { onError(r.error); return r; }
      view = r;
      push(r.graph);
      if (propsId && !r.graph.nodes.some((n) => n.id === propsId)) closeProps();
      onChange(r, null);
      return r;
    });
  }

  /** "Disable a (Virtual Input 1)? 2 input(s) using it will be disconnected." — FlowEditorTab's wording. */
  function removeMessage(ids) {
    const slots = (view?.slots || []).filter((s) => ids.includes(s.id));
    const names = slots.map((s) => `${s.name} (${s.label})`).join(', ');
    const refs = slots.reduce((n, s) => n + s.references, 0);
    return { slots, message: `Disable ${names}?` + (refs > 0 ? ` ${refs} input(s) using it will be disconnected.` : '') };
  }

  async function confirmRemove(ids) {
    const m = removeMessage(ids);
    if (!m.slots.length) return false;
    return (await confirm(m.message)) === true;
  }

  function openProps(id) { propsId = id; editor?.setPropertiesNode(id); onProps(id); }
  function closeProps() { propsId = null; editor?.setPropertiesNode(null); onProps(null); }

  const handlers = {
    OnConnect: (source, sourceHandle, target, targetHandle) => edit({ op: 'connect', source, sourceHandle, target, targetHandle }).then(() => undefined),
    ConfirmRemoveNodes: (ids) => confirmRemove(ids),
    OnDeleted: (nodeIds, edges) => edit({ op: 'delete', nodeIds, edges }).then(() => undefined),
    OnNodesMoved: (moves) => edit({ op: 'move', moves }).then(() => undefined),
    OnOpenProperties: (id) => { openProps(id); },
  };

  /** Stands in for Blazor's DotNetObjectReference. */
  const dotnet = {
    invokeMethodAsync(name, ...args) {
      const h = handlers[name];
      if (!h) return Promise.reject(new Error(`dotnet.${name}: not handled by the dingo-web adapter`));
      return Promise.resolve().then(() => h(...args));
    },
  };

  async function mount(element) {
    const r = await refresh();
    if (!r.ok) return r;
    const mod = await loadEditor();
    unmount();
    editor = await mod.create(element, dotnet, view.graph);
    if (propsId) editor.setPropertiesNode(propsId);
    fitWhenMeasured(element, editor);
    return r;
  }

  // React Flow's `fitView` prop fits once at init, while its canvas still has
  // no size, so the first view came up at maxZoom (scale 2) on one node (seen
  // in a foreground tab, 2026-10-05; the nodes were measured by then, the
  // canvas was not). Fit again once the canvas has a size and every node is
  // measured, a frame after React Flow's own resize observer has run; give up
  // after ~1.5 s rather than wait for ever.
  function fitWhenMeasured(element, handle) {
    if (typeof requestAnimationFrame !== 'function') return; // no layout (tests under Node)
    const deadline = performance.now() + 1500;
    const ready = () => {
      const pane = element.querySelector('.react-flow');
      const nodes = element.querySelectorAll('.react-flow__node');
      return !!pane && pane.clientWidth > 0 && pane.clientHeight > 0 &&
        nodes.length > 0 && [...nodes].every((n) => n.offsetWidth > 0 && n.offsetHeight > 0);
    };
    const tick = () => {
      if (editor !== handle) return; // remounted meanwhile
      if (ready()) requestAnimationFrame(() => requestAnimationFrame(() => editor === handle && handle.fitView()));
      else if (performance.now() < deadline) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function unmount() {
    if (editor) { try { editor.dispose(); } catch { /* already gone */ } }
    editor = null;
  }

  /** Add Function: enable a free slot at the middle of the view (FlowEditorTab.AddNodeAsync). */
  async function add(id) {
    const c = editor ? editor.getViewportCenter() : { x: 0, y: 0 };
    const r = await edit({ op: 'add', id, x: Math.round(c.x - 100), y: Math.round(c.y - 40) });
    if (r.ok) { openProps(id); editor?.selectNode(id); }
    return r;
  }

  /** The properties panel's Remove (asks first, like deleting the node). */
  async function remove(id) {
    if (!(await confirmRemove([id]))) return { ok: false, cancelled: true };
    return edit({ op: 'remove', id });
  }

  return {
    dotnet,
    mount,
    unmount,
    refresh,
    edit,
    add,
    remove,
    set: (id, field, value) => edit({ op: 'set', id, field, value }),
    props: (id) => api.graphNode(getText(), id, getBase()),
    openProps,
    closeProps,
    removeMessage,
    fitView: () => editor?.fitView(),
    get view() { return view; },
    get propsId() { return propsId; },
    get mounted() { return !!editor; },
  };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** The Add Function choices: free (disabled) slots grouped by type, as <optgroup>s. */
export function addOptionsHtml(slots) {
  const groups = new Map();
  for (const s of slots || []) {
    if (s.enabled) continue;
    if (!groups.has(s.type)) groups.set(s.type, []);
    groups.get(s.type).push(s);
  }
  let h = '<option value="">Add function…</option>';
  for (const [type, free] of groups) {
    h += `<optgroup label="${esc(type)}">` + free.map((s) => {
      // Default names are e.g. "flasher3" for "Flasher 3": only show a name someone gave it.
      const renamed = s.name.replace(/ /g, '').toLowerCase() !== s.label.replace(/ /g, '').toLowerCase();
      return `<option value="${esc(s.id)}">${esc(s.label)}${renamed ? ` (${esc(s.name)})` : ''}</option>`;
    }).join('') + '</optgroup>';
  }
  return h;
}

function fieldInput(f) {
  const attrs = `data-field="${esc(f.field)}" data-type="${esc(f.type)}" title="${esc(f.param)}"`;
  if (f.type === 'bool') return `<input type="checkbox" ${attrs}${f.value ? ' checked' : ''}>`;
  if (f.type === 'enum') {
    const seen = new Set();
    const opts = f.enum.map((name, i) => {
      const v = f.values[i];
      if (seen.has(v)) return ''; // aliases (Intel = LittleEndian)
      seen.add(v);
      return `<option value="${v}"${v === f.value ? ' selected' : ''}>${esc(name)}</option>`;
    }).join('');
    return `<select ${attrs}>${opts}</select>`;
  }
  const step = f.type === 'float' ? 'any' : '1';
  return `<input type="number" class="mono" step="${step}" min="${f.min}" max="${f.max}" value="${esc(f.value)}" ${attrs}>`;
}

/** The properties panel for api.graphNode()'s result. */
export function propsHtml(p) {
  const rows = p.fields.map((f) => `<label class="prop"><span>${esc(f.field)}</span>${fieldInput(f)}</label>`).join('');
  return `<div class="row props-head"><b>${esc(p.name)}</b><span class="hint">${esc(p.label)}</span>
      <span style="flex:1"></span>
      <button type="button" class="btn danger" data-prop-action="remove">Remove</button>
      <button type="button" class="btn" data-prop-action="close" title="close" aria-label="Close properties">✕</button></div>
    <div class="props-grid">
      <label class="prop"><span>name</span><input type="text" data-field="name" data-type="string" value="${esc(p.name)}"></label>
      <label class="prop"><span>enabled</span><input type="checkbox" data-field="enabled" data-type="bool"${p.enabled ? ' checked' : ''}></label>
      ${rows}
    </div>
    ${p.missing ? `<p class="hint">Edit in the JSON: ${esc(p.missing)}.</p>` : ''}`;
}

/** A properties input's value as graphEdit's set wants it. */
export function propValue(el) {
  const t = el.dataset.type;
  if (t === 'bool') return el.checked;
  if (t === 'string') return el.value;
  if (t === 'enum') return Number(el.value);
  return el.value.trim() === '' ? NaN : Number(el.value);
}
