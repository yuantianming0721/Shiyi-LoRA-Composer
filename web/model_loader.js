import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAME = "ShiyiModelLoader";
const PANEL_H = 300;

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
  .shiyi-ml-list{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:2px}
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
  .shiyi-ml-detail{flex:0 0 auto;display:flex;gap:8px;padding:5px 6px;background:#1a1a22;border:1px solid #2b2b35;
    border-radius:5px;min-height:64px}
  .shiyi-ml-detail .thumb{width:54px;height:54px;object-fit:cover;border-radius:4px;background:#14141a;flex:0 0 auto}
  .shiyi-ml-detail .thumb.empty{display:flex;align-items:center;justify-content:center;color:#4a4a56;font-size:9px}
  .shiyi-ml-meta{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;font-size:10.5px;color:#9a9aa8}
  .shiyi-ml-meta .k{color:#6d6d7a}
  .shiyi-ml-meta .v{color:#dcdce4}
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
  const list = el("div", "shiyi-ml-list");
  const detail = el("div", "shiyi-ml-detail");
  body.append(tabs, search, list, detail);
  root.append(bar, body);

  const widget = node.addDOMWidget("model_panel", "shiyi_panel", root, {
    serialize: false,
    hideOnZoom: false,
    getValue: () => "",
    setValue: () => {},
  });
  widget.computeSize = (width) => [width, root.classList.contains("collapsed") ? 34 : PANEL_H];

  node.__ml = { root, bar, arrow, current, tabs, search, list, detail, collapsed: false, kind: "checkpoint", keyword: "" };

  bar.onclick = () => {
    node.__ml.collapsed = !node.__ml.collapsed;
    root.classList.toggle("collapsed", node.__ml.collapsed);
    arrow.textContent = node.__ml.collapsed ? "▸" : "▾";
    resize(node);
  };

  return node.__ml;
}

function resize(node) {
  const panel = node.__ml?.collapsed ? 34 : PANEL_H;
  node.setSize([Math.max(460, node.size?.[0] || 460), panel + 170]);
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
  if (item.kind === "checkpoint") {
    const clip = item.bundled_clip ? "CLIP ✓" : "CLIP ✗";
    const vae = item.bundled_vae ? "VAE ✓" : "VAE ✗";
    const miss = (!item.bundled_clip || !item.bundled_vae) ? "（缺的手选补）" : "（都用内置）";
    line("内置", `${clip} / ${vae} ${miss}`);
  } else {
    line("提示", "无内置 CLIP / VAE，用下拉另配");
  }
  if (item.clip_type) line("CLIP 类型", `auto → ${item.clip_type}`);
  box.appendChild(meta);
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
      render(node);
    };
    ui.tabs.appendChild(btn);
  }

  const keyword = ui.keyword.trim().toLowerCase();
  const items = (data[ui.kind] || []).filter((item) => {
    if (!keyword) return true;
    return (
      String(item.name).toLowerCase().includes(keyword) ||
      String(item.arch).toLowerCase().includes(keyword) ||
      String(item.folder || "").toLowerCase().includes(keyword)
    );
  });

  ui.list.replaceChildren();
  if (!items.length) {
    ui.list.appendChild(el("div", "shiyi-ml-hint", data.gguf_ready === false && ui.kind === "gguf" ? "没有 .gguf 模型" : "没有匹配的模型"));
    return;
  }

  const selected = resolveSelection(modelWidget(node)?.value);
  const groups = new Map();
  for (const item of items) {
    const key = item.folder || "(根目录)";
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
      row.append(
        el("span", "name", item.label || item.name),
        el("span", "badge", item.precision),
        el("span", "size", item.size_text)
      );
      row.title = `${item.name}\n架构：${item.arch}（${item.arch_hint}）`;
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
      refresh(this);
      setTimeout(() => {
        if (this.size[0] < 460) this.setSize([460, Math.max(this.size[1], PANEL_H + 170)]);
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





