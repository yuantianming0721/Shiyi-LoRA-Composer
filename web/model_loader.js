import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAME = "ShiyiModelLoader";
const PANEL_H = 360;          // 首次放置时面板给的高度
const WIDGET_OFFSET = 216;    // 标题 + 四个下拉占掉的固定高度，面板高度 = 节点高 - 这个
const MIN_PANEL_H = 150;

const TABS = [
  { id: "checkpoint", label: "完整模型" },
  { id: "diffusion", label: "UNet" },
  { id: "gguf", label: "GGUF" },
];

let LIB = null;

async function loadLibrary() {
  if (LIB) return LIB;
  const res = await api.fetchApi("/shiyi_model/list", { cache: "no-store" });
  LIB = await res.json();
  return LIB;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function ensureStyle() {
  if (document.getElementById("shiyi-ml-style")) return;
  const style = document.createElement("style");
  style.id = "shiyi-ml-style";
  style.textContent = `
  .shiyi-ml{display:flex;flex-direction:column;height:100%;background:#191920;border:1px solid #2b2b35;
    border-radius:6px;overflow:hidden;font-family:'Microsoft YaHei',system-ui,sans-serif;color:#dcdce4}
  .shiyi-ml-bar{display:flex;align-items:center;gap:6px;padding:4px 8px;background:#22222b;cursor:pointer;
    font-size:11.5px;flex:0 0 auto;user-select:none}
  .shiyi-ml-bar .arrow{color:#8a8a99;font-size:10px}
  .shiyi-ml-bar .ttl{color:#cfe6ff}
  .shiyi-ml-bar .cur{margin-left:auto;color:#7d7d8c;font-size:10.5px;overflow:hidden;
    text-overflow:ellipsis;white-space:nowrap;max-width:55%}
  .shiyi-ml-body{flex:1;min-height:0;display:flex;flex-direction:column;gap:4px;padding:6px}
  .shiyi-ml.collapsed .shiyi-ml-body{display:none}
  .shiyi-ml-tabs{display:flex;gap:5px;flex:0 0 auto}
  .shiyi-ml-tab{padding:1px 8px;border-radius:11px;background:#242430;border:1px solid #33333d;color:#9a9aa8;
    font-size:11px;cursor:pointer;white-space:nowrap;user-select:none}
  .shiyi-ml-tab:hover{color:#dcdce4}
  .shiyi-ml-tab.on{background:#24405e;border-color:#3a689a;color:#cfe6ff}
  .shiyi-ml-search{flex:0 0 auto;background:#14141a;border:1px solid #33333d;border-radius:5px;color:#dcdce4;
    padding:3px 7px;font-size:11.5px;outline:none}
  .shiyi-ml-search:focus{border-color:#6fb3ff}
  .shiyi-ml-list{flex:1 1 160px;min-height:130px;overflow-y:auto;display:flex;flex-direction:column;gap:2px}
  .shiyi-ml-list::-webkit-scrollbar{width:9px}
  .shiyi-ml-list::-webkit-scrollbar-thumb{background:#3b3b48;border-radius:5px}
  .shiyi-ml-list::-webkit-scrollbar-track{background:transparent}
  .shiyi-ml-group{flex:0 0 auto;font-size:10.5px;color:#6d6d7a;padding:2px 4px 1px;border-bottom:1px solid #23232d}
  .shiyi-ml-row{flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:2px 6px;border-radius:4px;
    cursor:pointer;font-size:11px;background:#1d1d24}
  .shiyi-ml-row:hover{background:#262a35}
  .shiyi-ml-row.on{background:#24405e;color:#cfe6ff}
  .shiyi-ml-row .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .shiyi-ml-row .badge{flex:0 0 auto;font-size:10px;color:#8fc4ff;border:1px solid #2f4a66;border-radius:3px;
    padding:0 3px;line-height:13px}
  .shiyi-ml-row .size{flex:0 0 auto;font-size:10px;color:#6d6d7a}
  .shiyi-ml-filters{flex:0 0 auto;display:flex;gap:5px;padding:0 2px}
  .shiyi-ml-select{flex:1 1 0;min-width:0;background:#14141a;border:1px solid #33333d;border-radius:5px;color:#dcdce4;
    font-size:11px;padding:1px 4px;outline:none;font-family:inherit}
  .shiyi-ml-select:focus{border-color:#6fb3ff}
  .shiyi-ml-notes{flex:1 1 100%;width:100%;max-height:46px;overflow:hidden;color:#9a9aa8;font-size:10.5px;line-height:1.45;
    white-space:pre-wrap;word-break:break-word;cursor:pointer;padding-top:3px;border-top:1px dashed #2b2b35}
  .shiyi-ml-notes.open{max-height:150px;overflow:auto;color:#c2c2cf}
  .shiyi-ml-notes .more{color:#6fb3ff}
  .shiyi-ml-detail{flex:0 0 auto;display:flex;flex-wrap:wrap;gap:8px;padding:5px 6px;background:#1a1a22;border:1px solid #2b2b35;
    border-radius:5px;min-height:64px}
  .shiyi-ml-detail .thumb{width:54px;height:54px;object-fit:cover;border-radius:4px;background:#14141a;flex:0 0 auto}
  .shiyi-ml-detail .thumb.empty{display:flex;align-items:center;justify-content:center;color:#4a4a56;font-size:9px}
  .shiyi-ml-meta{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;font-size:10.5px;color:#9a9aa8}
  .shiyi-ml-meta .k{color:#6d6d7a}
  .shiyi-ml-meta .v{color:#dcdce4}
  .shiyi-ml-flag{flex:0 0 auto;font-size:8.5px;line-height:1.5;padding:0 3px;border-radius:3px;
    background:#1d3a26;border:1px solid #2f6b40;color:#7fd39a}
  .shiyi-ml-props{flex:1 1 100%;display:flex;flex-wrap:wrap;align-items:flex-start;gap:4px;margin-top:2px}
  .shiyi-ml-props .tag{flex:0 0 auto;font-size:9.5px;line-height:1.5;padding:0 5px;border-radius:3px;
    background:#1d3a26;border:1px solid #2f6b40;color:#7fd39a}
  .shiyi-ml-props .tag.off{background:#26262f;border-color:#3a3a46;color:#82828f}
  .shiyi-ml-hint{color:#6d6d7a;font-size:11px;padding:6px;text-align:center}
  `;
  document.head.appendChild(style);
}

function resolveSelection(value) {
  if (!value) return null;
  const match = /^\[(\w+)\]\s*(.+)$/.exec(value);
  if (!match) return null;
  return { kind: match[1], name: match[2] };
}

function buildPanel(node) {
  ensureStyle();
  const root = el("div", "shiyi-ml notranslate");
  root.setAttribute("translate", "no");
  const bar = el("div", "shiyi-ml-bar");
  const arrow = el("span", "arrow", "▾");
  const title = el("span", "ttl", "懒人的模型加载器");
  const current = el("span", "cur", "");
  bar.append(arrow, title, current);

  const body = el("div", "shiyi-ml-body");
  const tabs = el("div", "shiyi-ml-tabs");
  const search = document.createElement("input");
  search.className = "shiyi-ml-search";
  search.placeholder = "搜索模型";
  const filters = el("div", "shiyi-ml-filters");
  const seriesSel = document.createElement("select");
  seriesSel.className = "shiyi-ml-select";
  seriesSel.title = "按系列筛选";
  const sortSel = document.createElement("select");
  sortSel.className = "shiyi-ml-select";
  sortSel.title = "排序方式";
  for (const [value, label] of [["name", "名称 A→Z"], ["size", "大小 大到小"], ["mtime", "最近修改"], ["arch", "架构分组"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    sortSel.appendChild(option);
  }
  filters.append(seriesSel, sortSel);
  const list = el("div", "shiyi-ml-list");
  const detail = el("div", "shiyi-ml-detail");
  body.append(tabs, filters, search, list, detail);
  root.append(bar, body);

  const widget = node.addDOMWidget("model_panel", "shiyi_panel", root, {
    serialize: false,
    hideOnZoom: false,
    getValue: () => "",
    setValue: () => {},
  });
  widget.computeSize = (width) => {
    if (root.classList.contains("collapsed")) return [width, 34];
    const nodeHeight = node.size?.[1] || PANEL_H + WIDGET_OFFSET;
    return [width, Math.max(MIN_PANEL_H, nodeHeight - WIDGET_OFFSET)];
  };

  node.__ml = { root, bar, arrow, current, tabs, search, list, detail, seriesSel, sortSel, collapsed: false, kind: "checkpoint", keyword: "", series: "", sort: "name" };

  bar.onclick = () => {
    node.__ml.collapsed = !node.__ml.collapsed;
    root.classList.toggle("collapsed", node.__ml.collapsed);
    arrow.textContent = node.__ml.collapsed ? "▸" : "▾";
    resize(node);
  };

  return node.__ml;
}

function resize(node) {
  // 折叠只缩到标题栏；展开时恢复折叠前的高度，不覆盖用户拉出来的尺寸
  const ui = node.__ml;
  if (!ui) return;
  let height;
  if (ui.collapsed) {
    ui.expandedHeight = Math.max(node.size?.[1] || 0, MIN_PANEL_H + WIDGET_OFFSET);
    height = WIDGET_OFFSET + 34;
  } else {
    height = Math.max(ui.expandedHeight || PANEL_H + WIDGET_OFFSET, MIN_PANEL_H + WIDGET_OFFSET);
  }
  node.setSize([Math.max(460, node.size?.[0] || 460), height]);
}

function modelWidget(node) {
  return node.widgets?.find((widget) => widget.name === "model");
}

function applySelection(node, item) {
  const widget = modelWidget(node);
  const value = `[${item.kind}] ${item.name}`;
  if (widget) {
    widget.value = value;
    if (Array.isArray(widget.options?.values) && !widget.options.values.includes(value)) {
      widget.options.values.push(value);
    }
  }
  node.__ml.current.textContent = item.label || item.name;
  node.setDirtyCanvas(true, true);
}

function renderDetail(node, item) {
  const box = node.__ml.detail;
  box.replaceChildren();
  const thumb = document.createElement("img");
  thumb.className = "thumb";
  if (item.preview) {
    thumb.src = api.apiURL(`/shiyi_model/preview?kind=${encodeURIComponent(item.kind)}&name=${encodeURIComponent(item.name)}`);
    thumb.onerror = () => {
      thumb.replaceWith(el("div", "thumb empty", "无图"));
    };
  } else {
    const ph = el("div", "thumb empty", "无图");
    box.appendChild(ph);
  }
  if (item.preview) box.appendChild(thumb);

  const meta = el("div", "shiyi-ml-meta");
  const line = (key, value) => {
    const row = el("div");
    row.append(el("span", "k", `${key}：`), el("span", "v", value));
    meta.appendChild(row);
  };
  line("架构", `${item.arch}（${item.arch_hint}）`);
  line("规格", `${item.format} · ${item.precision} · ${(item.tensors || 0).toLocaleString()} 张量 · ${item.size_text}`);
  if (item.repo) line("来源", `${item.repo}${item.component ? ` / ${item.component}` : ""}`);
  if (item.clip_type) line("CLIP 类型", `auto → ${item.clip_type}`);
  box.appendChild(meta);

  const props = el("div", "shiyi-ml-props");
  const tag = (text, on, why) => {
    const node = el("span", "tag" + (on ? "" : " off"), `${text} ${on ? "✓" : "✗"}`);
    node.title = why;
    return node;
  };
  props.append(
    tag("自带 CLIP", item.bundled_clip, item.bundled_clip ? "模型里含文本编码器，不用外接" : "需要用 clip_name 外接"),
    tag("自带 VAE", item.bundled_vae, item.bundled_vae ? "模型里含 VAE，不用外接" : "需要用 vae_name 外接")
  );
  box.appendChild(props);

  if (item.notes) {
    const notes = el("div", "shiyi-ml-notes", item.notes);
    notes.title = "点一下展开 / 收起";
    notes.onclick = () => notes.classList.toggle("open");
    box.appendChild(notes);
  }
}

function refreshSeries(node, pool) {
  const ui = node.__ml;
  const folders = new Set();
  for (const item of pool) folders.add(item.folder || "");
  if (ui.series && !folders.has(ui.series)) ui.series = "";

  const signature = [...folders].sort().join("\u0000");
  if (ui.seriesSignature === signature) return;
  ui.seriesSignature = signature;

  const options = [["", `全部系列（${pool.length}）`]];
  for (const folder of [...folders].sort((a, b) => a.localeCompare(b, "zh"))) {
    const count = pool.filter((item) => (item.folder || "") === folder).length;
    options.push([folder, `${folder || "(根目录)"}（${count}）`]);
  }
  ui.seriesSel.replaceChildren();
  for (const [value, label] of options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    ui.seriesSel.appendChild(option);
  }
  ui.seriesSel.value = ui.series;
  ui.seriesSel.onchange = () => {
    ui.series = ui.seriesSel.value;
    render(node);
  };
  ui.sortSel.value = ui.sort;
  ui.sortSel.onchange = () => {
    ui.sort = ui.sortSel.value;
    render(node);
  };
}

function render(node) {
  const ui = node.__ml;
  const data = node.__data;
  if (!data) {
    ui.list.replaceChildren(el("div", "shiyi-ml-hint", "读取模型列表…"));
    return;
  }
  const counts = {
    checkpoint: data.checkpoint.length,
    diffusion: data.diffusion.length,
    gguf: data.gguf.length,
  };
  ui.tabs.replaceChildren();
  for (const tab of TABS) {
    const btn = el("div", "shiyi-ml-tab" + (ui.kind === tab.id ? " on" : ""), `${tab.label} ${counts[tab.id]}`);
    btn.onclick = () => {
      ui.kind = tab.id;
      ui.seriesSignature = null;
      render(node);
    };
    ui.tabs.appendChild(btn);
  }

  const pool = data[ui.kind] || [];
  refreshSeries(node, pool);

  const keyword = ui.keyword.trim().toLowerCase();
  const items = pool.filter((item) => {
    if (ui.series && (item.folder || "") !== ui.series) return false;
    if (!keyword) return true;
    return (
      String(item.name).toLowerCase().includes(keyword) ||
      String(item.arch).toLowerCase().includes(keyword) ||
      String(item.folder || "").toLowerCase().includes(keyword)
    );
  });

  const byName = (a, b) => String(a.label || a.name).localeCompare(String(b.label || b.name), "zh");
  if (ui.sort === "size") items.sort((a, b) => (b.size || 0) - (a.size || 0));
  else if (ui.sort === "mtime") items.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  else if (ui.sort === "arch") items.sort((a, b) => String(a.arch).localeCompare(String(b.arch), "zh") || byName(a, b));
  else items.sort(byName);

  ui.list.replaceChildren();
  if (!items.length) {
    ui.list.appendChild(el("div", "shiyi-ml-hint", data.gguf_ready === false && ui.kind === "gguf" ? "没有 .gguf 模型" : "没有匹配的模型"));
    return;
  }

  const selected = resolveSelection(modelWidget(node)?.value);
  const groups = new Map();
  for (const item of items) {
    const key = ui.sort === "arch" ? item.arch : item.folder || "(根目录)";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const [folder, entries] of groups) {
    if (folder !== "(根目录)") ui.list.appendChild(el("div", "shiyi-ml-group", folder));
    for (const item of entries) {
      const row = el("div", "shiyi-ml-row");
      const on = selected && selected.kind === item.kind && selected.name === item.name;
      if (on) {
        row.classList.add("on");
        renderDetail(node, item);
      }
      row.append(el("span", "name", item.label || item.name));
      if (item.bundled_clip) {
        const flag = el("span", "shiyi-ml-flag", "CLIP");
        flag.title = "自带 CLIP（无需外接）";
        row.appendChild(flag);
      }
      if (item.bundled_vae) {
        const flag = el("span", "shiyi-ml-flag", "VAE");
        flag.title = "自带 VAE（无需外接）";
        row.appendChild(flag);
      }
      row.append(el("span", "badge", item.precision), el("span", "size", item.size_text));
      row.title = `${item.name}\n架构：${item.arch}（${item.arch_hint}）\n自带 CLIP：${item.bundled_clip ? "是" : "否"}　自带 VAE：${item.bundled_vae ? "是" : "否"}`;
      row.onclick = () => {
        applySelection(node, item);
        render(node);
      };
      ui.list.appendChild(row);
    }
  }
}

async function refresh(node) {
  const ui = node.__ml;
  ui.list.replaceChildren(el("div", "shiyi-ml-hint", "读取模型列表…"));
  try {
    node.__data = await loadLibrary();
  } catch (error) {
    ui.list.replaceChildren(el("div", "shiyi-ml-hint", `读取失败：${error.message}`));
    return;
  }
  render(node);
}

app.registerExtension({
  name: "Shiyi.ModelLoader",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onNodeCreated?.apply(this, arguments);
      const ui = buildPanel(this);
      ui.search.addEventListener("input", () => {
        ui.keyword = ui.search.value;
        render(this);
      });
      ui.search.addEventListener("keydown", (event) => event.stopPropagation());
      const select = modelWidget(this);
      if (select) select.label = "当前模型";
      const onResize = this.onResize;
      this.onResize = function () {
        onResize?.apply(this, arguments);
        if (!this.__ml || this.__ml.collapsed) return;
        const minHeight = MIN_PANEL_H + WIDGET_OFFSET;
        if (this.size[1] < minHeight) this.setSize([this.size[0], minHeight]);
        this.setDirtyCanvas(true, false);
      };
      refresh(this);
      setTimeout(() => {
        const width = Math.max(460, this.size[0]);
        if (!this.__ml?.sized) {
          if (this.__ml) this.__ml.sized = true;
          this.setSize([width, Math.max(this.size[1], PANEL_H + WIDGET_OFFSET)]);
        } else if (this.size[0] < 460 || this.size[1] < MIN_PANEL_H + WIDGET_OFFSET) {
          this.setSize([width, Math.max(this.size[1], MIN_PANEL_H + WIDGET_OFFSET)]);
        }
        this.setDirtyCanvas(true, false);
      }, 80);
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConfigure?.apply(this, arguments);
      const value = modelWidget(this)?.value;
      if (value && this.__ml) {
        const parsed = resolveSelection(value);
        if (parsed) this.__ml.current.textContent = parsed.name;
      }
      setTimeout(() => refresh(this), 60);
    };
  },
});





