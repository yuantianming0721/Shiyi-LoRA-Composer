import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAME = "ShiyiLoraClipEncode";
const TABS = [
  { id: "lora", label: "LoRA" },
  { id: "tags", label: "常用 tag" },
  { id: "fav", label: "收藏" },
  { id: "fibo", label: "Fibo 编辑" },
];

const PANEL_H_OPEN = 260;
const PANEL_H_TAGS = 380;
const PANEL_H_FIBO = 420;
const PANEL_H_CLOSED = 46;

const INFO_CACHE = new Map();

/* ------------------------------------------------------------------ 工具 */

function shortLabel(name) {
  const base = String(name).split("/").pop() || name;
  return base.replace(/\.(safetensors|ckpt|pt|pth|sft)$/i, "");
}

function folderOf(name) {
  const parts = String(name).split("/");
  parts.pop();
  return parts.join("/");
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function getInfo(name) {
  if (INFO_CACHE.has(name)) return INFO_CACHE.get(name);
  const res = await api.fetchApi(`/shiyi_lora/info?name=${encodeURIComponent(name)}`, {
    cache: "no-store",
  });
  const info = await res.json();
  INFO_CACHE.set(name, info);
  return info;
}

async function enrichLora(node, name) {
  toast("查询 Civitai…");
  try {
    const res = await api.fetchApi("/shiyi_lora/enrich", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    INFO_CACHE.delete(name);
    if (!data.ok) {
      toast(data.error || "Civitai 上没有这个文件");
      return;
    }
    const written = (data.written || []).filter((file) => !file.endsWith(".metadata.json"));
    toast(written.length ? `已补：${written.join("、")}` : "查到模型，但没有可写的说明或图片");
    apply(node);
  } catch (error) {
    toast(`补全失败：${error.message}`);
  }
}

async function enrichBatch(node, names) {
  const picked = names.slice(0, 8);
  toast(`逐个补 ${picked.length} 个，可能要等一会儿…`);
  try {
    const res = await api.fetchApi("/shiyi_lora/enrich_batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ names: picked, limit: 8 }),
    });
    const data = await res.json();
    names.forEach((name) => INFO_CACHE.delete(name));
    toast(`补全：成功 ${(data.done || []).length}，未命中 ${(data.failed || []).length}`);
    apply(node);
  } catch (error) {
    toast(`批量补全失败：${error.message}`);
  }
}

function previewUrl(name) {
  const path = `/shiyi_lora/preview?name=${encodeURIComponent(name)}`;
  return api.apiURL ? api.apiURL(path) : path;
}

/* ------------------------------------------------------------------ 节点数据 */


function graphOf(node) {
  return node.graph || app.graph;
}

function linkOf(node, linkId) {
  const links = graphOf(node)?.links;
  if (!links || linkId == null) return null;
  if (Array.isArray(links)) return links.find((link) => link && link.id === linkId) || null;
  return links[linkId] || null;
}

function originOf(node, linkId, depth = 0) {
  if (linkId == null || depth > 6) return null;
  const graph = graphOf(node);
  const link = linkOf(node, linkId);
  if (!link) return null;
  const origin = graph?.getNodeById?.(link.origin_id);
  if (!origin) return null;
  if (Array.isArray(origin.__rows)) return origin;
  if (origin.type === "Reroute") {
    const input = (origin.inputs || [])[0];
    return originOf(origin, input?.link, depth + 1);
  }
  return null;
}

function triggersInput(node) {
  return (node.inputs || []).find((slot) => slot.name === "triggers");
}

function findStacks(node) {
  const graph = graphOf(node);
  const nodes = graph?._nodes || [];
  return nodes
    .filter((other) => other && other !== node && Array.isArray(other.__rows))
    .sort((a, b) => {
      const activeA = a.__rows.filter((row) => row && row.name && row.on !== false).length;
      const activeB = b.__rows.filter((row) => row && row.name && row.on !== false).length;
      return activeB - activeA;
    });
}

// 优先用连线；没连线时退回「图里第一个有启用行的编排器」，面板不再空白
function resolveSource(node) {
  const input = triggersInput(node);
  const link = linkOf(node, input?.link);
  const linked = originOf(node, input?.link);
  if (linked) return { stack: linked, linked: true, outSlot: link?.origin_slot ?? null };
  const fallback = findStacks(node).find((stack) => collectRows(stack).length);
  return { stack: fallback || null, linked: false, outSlot: null };
}

function stackFor(node) {
  return resolveSource(node).stack;
}

function connectStack(node, targetSlot = 3) {
  const stack = resolveSource(node).stack;
  const input = triggersInput(node);
  if (!stack || !input) return false;
  const graph = graphOf(node);
  if (input.link != null) {
    if (typeof graph.removeLink === "function") graph.removeLink(input.link);
    else graph.disconnect?.(node, node.inputs.indexOf(input));
  }
  const inputSlot = node.inputs.indexOf(input);
  if (typeof stack.connect === "function") stack.connect(targetSlot, node, inputSlot);
  if (input.link == null && typeof graph.addLink === "function") {
    graph.addLink({
      origin_id: stack.id,
      origin_slot: targetSlot,
      target_id: node.id,
      target_slot: inputSlot,
      type: "STRING",
    });
  }
  node.setDirtyCanvas(true, true);
  return true;
}

function collectRows(stack) {
  if (!stack || !Array.isArray(stack.__rows)) return [];
  const out = [];
  stack.__rows.forEach((row, index) => {
    if (!row || !row.name || row.on === false) return;
    const folder = folderOf(row.name);
    out.push({ row, index, name: row.name, label: shortLabel(row.name), folder });
  });
  out.sort(
    (a, b) =>
      (a.folder || "").localeCompare(b.folder || "", "zh") || a.label.localeCompare(b.label, "zh")
  );
  return out;
}

/* ------------------------------------------------------------------ 样式 */

let styleReady = false;

function ensureStyle() {
  if (styleReady) return;
  styleReady = true;
  const style = document.createElement("style");
  style.textContent = `
  .shiyi-lp{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;padding:4px 6px;
    background:#191920;border:1px solid #2f2f3a;border-radius:6px;color:#dcdce4;
    font-family:'Microsoft YaHei','PingFang SC',system-ui,sans-serif;font-size:12px;overflow:hidden}
  .shiyi-lp-bar{display:flex;align-items:center;gap:8px;flex:0 0 auto;min-height:22px;cursor:pointer;user-select:none;padding:2px 2px}
  .shiyi-lp-bar:hover{color:#fff}
  .shiyi-lp-bar .arrow{color:#7d7d8c;font-size:10px;width:10px}
  .shiyi-lp-bar .ttl{color:#b9b9c6;font-size:11.5px;white-space:nowrap}
  .shiyi-lp-bar .sum{flex:1;color:#6d6d7a;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .shiyi-lp-body{display:flex;flex-direction:column;gap:4px;flex:1 1 auto;min-height:0;overflow:hidden;margin-top:4px}
  .shiyi-lp.collapsed .shiyi-lp-body{display:none}
  .shiyi-lp-page{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:4px;overflow:hidden}
  .shiyi-lp-btn{background:#282833;border:1px solid #3b3b48;color:#c7c7d4;border-radius:5px;padding:2px 8px;font-size:11px;cursor:pointer;white-space:nowrap}
  .shiyi-lp-btn:hover{background:#32323f}
  .shiyi-lp-list{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:3px;padding-right:2px}
  .shiyi-lp-form{display:flex;flex-direction:column;gap:4px;flex:0 0 auto;padding:4px 2px}
  .shiyi-lp-textarea{width:100%;box-sizing:border-box;background:#14141a;border:1px solid #33333d;border-radius:5px;
    color:#dcdce4;padding:4px 7px;font-size:11.5px;line-height:1.5;resize:vertical;outline:none;
    font-family:'Consolas','Microsoft YaHei',monospace}
  .shiyi-lp-textarea:focus{border-color:#6fb3ff}
  .shiyi-lp-chip.add{color:#8fc4ff;border-style:dashed}
  .shiyi-lp-toast-btn{color:#8fc4ff;cursor:pointer;border-bottom:1px dashed #3a689a;padding-bottom:1px}
  .shiyi-lp-toast-btn:hover{color:#fff}
  .shiyi-lp-badge{margin-left:4px;font-size:9.5px;color:#d8b26a;border:1px solid #4a3d26;
    background:#2a2418;border-radius:3px;padding:0 3px;line-height:13px;flex:0 0 auto}
  .shiyi-lp-btn.danger{color:#ff9a9a;border-color:#5a2a2e;background:#3a2224}
  .shiyi-lp-favbar{display:flex;align-items:center;justify-content:space-between;gap:6px;flex:0 0 auto;
    background:#1a1a22;border:1px solid #2b2b35;border-radius:5px;padding:2px 7px}
  .shiyi-lp-favbar .shiyi-lp-btn{background:#22222b}
  .shiyi-lp-meta{color:#6d6d7a;font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .shiyi-lp-menu{position:fixed;z-index:100000;min-width:132px;padding:4px;background:#1d1d24;
    border:1px solid #3a3a46;border-radius:6px;box-shadow:0 6px 18px rgba(0,0,0,.5);
    font-size:11.5px;color:#dcdce4}
  .shiyi-lp-menu .item{padding:4px 8px;border-radius:4px;cursor:pointer;white-space:nowrap}
  .shiyi-lp-menu .item:hover{background:#2b3f55}
  .shiyi-lp-menu .item.danger{color:#ff9a9a}
  .shiyi-lp-menu .item.danger:hover{background:#3a2224}  .shiyi-lp-favlist{display:flex;flex-direction:column;gap:3px;flex:0 0 auto}
  .shiyi-lp-favrow{display:flex;gap:6px;align-items:flex-start;padding:3px 6px;border-radius:4px;
    background:#20222b;cursor:pointer;flex:0 0 auto}
  .shiyi-lp-favrow:hover{background:#262a35}
  .shiyi-lp-favinfo{flex:1;min-width:0}
  .shiyi-lp-favinfo .n{font-size:11px;color:#dcdce4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .shiyi-lp-favinfo .n .cat{color:#6d7d8a;font-size:10.5px}
  .shiyi-lp-favinfo .t{font-size:10.5px;color:#8a8a99;line-height:1.4;word-break:break-word;
    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    border:1px solid #3a3a46;border-radius:3px;cursor:pointer;user-select:none}
  .shiyi-lp-tagrows .shiyi-lp-row{padding-left:6px;min-height:18px}
  .shiyi-lp-tagrows .shiyi-lp-tag{max-width:58%;font-size:11px}
  .shiyi-lp-tagrows .shiyi-lp-en{max-width:40%;font-size:10.5px}
  .shiyi-lp-groups{display:grid;grid-template-columns:1fr 1fr;gap:3px;align-items:start}
  .shiyi-lp-group.wide{grid-column:1 / -1}
  .shiyi-lp-group{flex:0 0 auto;border:1px solid #2b2b35;border-radius:5px;overflow:hidden;background:#1d1d24}
  .shiyi-lp-ghead{flex:0 0 auto;min-height:16px;display:flex;align-items:center;gap:5px;padding:1px 6px;background:#22222b;cursor:pointer;user-select:none;font-size:11px;line-height:14px}
  .shiyi-lp-ghead:hover{background:#272733}
  .shiyi-lp-ghead .arrow{color:#7d7d8c;font-size:10px;width:10px}
  .shiyi-lp-ghead .gname{font-size:11.5px;color:#b9b9c6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .shiyi-lp-row{flex:0 0 auto;min-height:19px;display:flex;align-items:center;gap:6px;padding:2px 7px 2px 16px;cursor:pointer}
  .shiyi-lp-row:hover{background:#24242e}
  .shiyi-lp-name{width:120px;flex:0 0 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#dcdce4;font-size:11.5px}
  .shiyi-lp-del{margin-left:auto;flex:0 0 auto;font-size:11px;color:#8a8a99;padding:0 6px;line-height:16px;
    border:1px solid #3a3a46;border-radius:4px;cursor:pointer;user-select:none;opacity:0;transition:opacity .12s}
  .shiyi-lp-row:hover .shiyi-lp-del{opacity:.85}
  .shiyi-lp-del:hover{opacity:1;color:#ff9a9a;border-color:#5a2a2e;background:#3a2224}
  .shiyi-lp-toast{position:fixed;left:50%;bottom:38px;transform:translateX(-50%) translateY(8px);z-index:99999;
    padding:6px 14px;border-radius:6px;background:#282833;border:1px solid #3b3b48;color:#dcdce4;
    font:12px 'Microsoft YaHei',system-ui,sans-serif;opacity:0;pointer-events:none;transition:opacity .15s,transform .15s}
  .shiyi-lp-toast.on{opacity:1;transform:translateX(-50%) translateY(0)}

  .shiyi-lp-hint{color:#6d6d7a;padding:10px 6px;text-align:center;font-size:11.5px;line-height:1.6}
  .shiyi-lp-timer{color:#8fc4ff;font-variant-numeric:tabular-nums;font-weight:600}
  .shiyi-lp-tabs{display:flex;align-items:center;gap:6px;flex:0 0 auto;margin-bottom:4px}
  .shiyi-lp-tab{padding:2px 9px;border-radius:5px;background:#242430;border:1px solid #33333d;color:#9a9aa8;
    cursor:pointer;font-size:11.5px;white-space:nowrap;user-select:none}
  .shiyi-lp-tab:hover{color:#dcdce4}
  .shiyi-lp-tab.on{background:#24405e;border-color:#3a689a;color:#cfe6ff}
  .shiyi-lp-chips{display:flex;flex-wrap:wrap;gap:4px 5px;flex:0 0 auto}
  .shiyi-lp-chip{padding:1px 8px;border-radius:11px;background:#242430;border:1px solid #33333d;color:#9a9aa8;
    font-size:11px;white-space:nowrap;cursor:pointer;user-select:none}
  .shiyi-lp-chip:hover{color:#dcdce4}
  .shiyi-lp-chip.on{background:#24405e;border-color:#3a689a;color:#cfe6ff}
  .shiyi-lp-tag{flex:0 0 auto;max-width:52%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#dcdce4;font-size:11.5px}
  .shiyi-lp-en{margin-left:auto;max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#6f8a74;font-size:11px}
  .shiyi-lp-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;flex:1;color:#6d6d7a}
  .shiyi-lp-empty .t{font-size:12.5px;color:#b9b9c6}
  .shiyi-lp-empty .d{font-size:11.5px}
  .shiyi-lp-list::-webkit-scrollbar{width:9px}
  .shiyi-lp-list::-webkit-scrollbar-thumb{background:#3b3b48;border-radius:5px}
  .shiyi-lp-list::-webkit-scrollbar-thumb:hover{background:#4d4d5c}
  .shiyi-lp-list::-webkit-scrollbar-track{background:transparent}
  .shiyi-lp-doc{display:flex;flex-direction:column;gap:2px;padding:3px 4px 4px 14px;margin:0 0 3px 4px;border-left:2px solid #2f4a66}
  .shiyi-lp-doc-sec{display:flex;flex-direction:column;gap:1px;padding:3px 6px;border-radius:4px;background:#20222b;
    cursor:pointer;font-size:11px;color:#dcdce4}
  .shiyi-lp-doc-head{display:flex;align-items:center;gap:6px}
  .shiyi-lp-doc-text{color:#8a8a99;font-size:10.5px;line-height:1.45;word-break:break-word;
    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .shiyi-lp-doc-sec:hover{background:#262a35}
  .shiyi-lp-doc-sec.on{background:#24405e;color:#cfe6ff}
  .shiyi-lp-doc-sec.on .shiyi-lp-doc-text{color:#a8bccd}
  .shiyi-lp-doc-sec .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .shiyi-lp-doc-sec .hint{flex:0 0 auto;color:#6d6d7a;font-size:10.5px}
  .shiyi-lp-doc-sec.on .hint{color:#8fc4ff}
  .shiyi-lp-doc .shiyi-lp-hint{padding:4px 2px;text-align:left}
  .shiyi-lp-warn{display:flex;align-items:center;gap:8px;flex:0 0 auto;padding:3px 7px;border-radius:5px;
    background:#2f2a1c;border:1px solid #5a4a24;color:#e2c47a;font-size:11px}
  .shiyi-lp-warn .shiyi-lp-btn{background:#3a3220;border-color:#6a5626;color:#f0d79a}
  .shiyi-lp-confirm{display:flex;align-items:center;gap:6px;flex:0 0 auto;padding:3px 7px;border-radius:5px;
    background:#2f2a1c;border:1px solid #5a4a24;color:#e2c47a;font-size:11px}
  .shiyi-lp-confirm span{flex:1;min-width:0}
  .shiyi-lp-confirm .shiyi-lp-btn{background:#3a3220;border-color:#6a5626;color:#f0d79a}
  .shiyi-lp-fibo-help{display:flex;flex-direction:column;gap:3px;padding:2px 0}
  .shiyi-lp-fibo-helpwrap{flex:0 0 auto;max-height:150px;overflow-y:auto;border-top:1px solid #2b2b35;padding-top:2px}
  .shiyi-lp-fibo-helpwrap::-webkit-scrollbar{width:9px}
  .shiyi-lp-fibo-helpwrap::-webkit-scrollbar-thumb{background:#3b3b48;border-radius:5px}
  .shiyi-lp-fibo-row{border-left:2px solid #2f4a66;background:#20222b;border-radius:4px;padding:3px 6px}
  .shiyi-lp-fibo-k{font-size:11px;color:#cfe6ff;margin-bottom:1px}
  .shiyi-lp-fibo-v{font-size:10.5px;color:#8a8a99;line-height:1.45}
  .shiyi-lp-select{background:#14141a;border:1px solid #33333d;border-radius:5px;color:#c7c7d4;
    font-size:10.5px;padding:1px 4px;max-width:170px;outline:none}
  .shiyi-lp-select:focus{border-color:#6fb3ff}
  `;
  document.head.appendChild(style);
}

/* ------------------------------------------------------------------ 面板 */

function ensurePanel(node) {
  if (node.__lp) return node.__lp;
  ensureStyle();

  const root = el("div", "shiyi-lp");

  const bar = el("div", "shiyi-lp-bar");
  const arrow = el("span", "arrow", "▸");
  const title = el("span", "ttl", "便携提示词添加");
  bar.append(arrow, title);

  const body = el("div", "shiyi-lp-body");
  const tabs = el("div", "shiyi-lp-tabs");
  const pageWords = el("div", "shiyi-lp-page");
  body.append(tabs, pageWords);

  root.append(bar, body);

  const widget = node.addDOMWidget("lora_panel", "shiyi_panel", root, {
    serialize: false,
    hideOnZoom: false,
    getValue: () => "",
    setValue: () => {},
  });
  widget.computeSize = (width) => [width, panelHeight(node)];

  node.__lp = {
    root,
    body,
    tabs,
    widget,
    arrow,
    pageWords,
    collapsed: new Set(),
  };

  const props = node.properties || (node.properties = {});
  if (typeof props.panelOpen !== "boolean") props.panelOpen = false;
  if (typeof props.selectedLora !== "string") props.selectedLora = "";
  if (typeof props.tab !== "string") props.tab = "lora";

  for (const tab of TABS) {
    const btn = el("div", "shiyi-lp-tab", tab.label);
    btn.dataset.tab = tab.id;
    btn.onclick = (event) => {
      event.stopPropagation();
      props.tab = tab.id;
      apply(node);
    };
    tabs.appendChild(btn);
  }

  bar.onclick = () => {
    props.panelOpen = !props.panelOpen;
    apply(node);
    fit(node);
  };
  return node.__lp;
}


let toastEl = null;

function toast(message, action = null) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.className = "shiyi-lp-toast";
    document.body.appendChild(toastEl);
  }
  toastEl.replaceChildren(document.createTextNode(message));
  if (action) {
    const btn = el("span", "shiyi-lp-toast-btn", action.label);
    btn.onclick = () => {
      toastEl.classList.remove("on");
      action.run();
    };
    toastEl.appendChild(btn);
  }
  toastEl.classList.add("on");
  clearTimeout(toastEl.__timer);
  toastEl.__timer = setTimeout(
    () => toastEl.classList.remove("on"),
    action ? 6000 : 1500
  );
}

// 把文本插到节点 text 输入框的光标处
// 插入成独立的一块（整行），不再往同一行里堆逗号
// block=true 时独占一行（LoRA 说明里的整段）；否则按逗号接在末尾（单个 tag / 触发词）
function insertPrompt(node, raw, block = false, focus = true) {
  const text = String(raw || "").trim();
  if (!text) return false;
  const widget = node.widgets?.find((item) => item.name === "text");
  if (!widget) return false;
  const area = widget.element;
  const value = String(area ? area.value : widget.value || "");
  if (block ? hasBlock(node, text) : containsTag(node, text)) return false;
  let next;
  if (block) {
    next = value.trim() ? `${value.replace(/\s+$/, "")}\n${text}` : text;
  } else {
    const head = value.replace(/[\s,，]+$/, "");
    next = head ? `${head}, ${text}` : text;
  }
  if (area) {
    area.value = next;
    area.selectionStart = area.selectionEnd = next.length;
    area.dispatchEvent(new Event("input", { bubbles: true }));
  }
  widget.value = next;
  if (focus) area?.focus();
  return true;
}

// 按逗号项判断某个 tag 是否已经存在
function containsTag(node, raw) {
  const target = String(raw || "").trim().toLowerCase();
  if (!target) return false;
  const widget = node.widgets?.find((item) => item.name === "text");
  const value = String(widget?.value || "");
  return value
    .split(/\r?\n/)
    .some((line) => line.split(/[,，]/).some((item) => item.trim().toLowerCase() === target));
}


function hasBlock(node, raw) {
  const text = String(raw || "").trim().toLowerCase();
  if (!text) return false;
  const widget = node.widgets?.find((item) => item.name === "text");
  const value = String(widget?.value || "");
  return value.split(/\r?\n/).some((line) => line.trim().toLowerCase() === text);
}

// 删除一整块（整行匹配），顺带收掉多余空行
function removePromptBlock(node, raw) {
  const text = String(raw || "").trim().toLowerCase();
  if (!text) return false;
  const widget = node.widgets?.find((item) => item.name === "text");
  if (!widget) return false;
  const area = widget.element;
  const value = String(area ? area.value : widget.value || "");
  const lines = value.split(/\r?\n/);
  const kept = lines.filter((line) => line.trim().toLowerCase() !== text);
  if (kept.length === lines.length) return false;
  const next = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (area) {
    area.value = next;
    area.dispatchEvent(new Event("input", { bubbles: true }));
  }
  widget.value = next;
  return true;
}

// 删除所有含这个词的整块（触发词块、从说明页插进来的段落块都算）
// 删掉某个词带来的影响：以它开头的整段（说明页插的块）整行删；和别的 tag 同行的只删那一项
function removeBlocksContaining(node, raw) {
  const target = String(raw || "").trim().toLowerCase();
  if (!target) return 0;
  const widget = node.widgets?.find((item) => item.name === "text");
  if (!widget) return 0;
  const area = widget.element;
  const value = String(area ? area.value : widget.value || "");
  let removed = 0;
  const kept = [];
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const items = trimmed.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
    if (!items.length) continue;
    // 整段被插进来的块都以触发词开头，整行丢掉
    if (items.length > 1 && items[0].toLowerCase() === target) {
      removed += 1;
      continue;
    }
    const rest = items.filter((item) => item.toLowerCase() !== target);
    if (rest.length !== items.length) removed += 1;
    if (rest.length) kept.push(rest.join(", "));
  }
  if (!removed) return 0;
  const next = kept.join("\n").trim();
  if (area) {
    area.value = next;
    area.dispatchEvent(new Event("input", { bubbles: true }));
  }
  widget.value = next;
  return removed;
}

// 只删等于该词的逗号项（保留同行其它内容，也不动整段行）
function removeTagItem(node, raw) {
  const target = String(raw || "").trim().toLowerCase();
  if (!target) return 0;
  const widget = node.widgets?.find((item) => item.name === "text");
  if (!widget) return 0;
  const area = widget.element;
  const value = String(area ? area.value : widget.value || "");
  let removed = 0;
  const kept = [];
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const items = trimmed.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
    const rest = items.filter((item) => item.toLowerCase() !== target);
    if (rest.length !== items.length) removed += 1;
    if (rest.length) kept.push(rest.join(", "));
  }
  if (!removed) return 0;
  const next = kept.join("\n").trim();
  if (area) {
    area.value = next;
    area.dispatchEvent(new Event("input", { bubbles: true }));
  }
  widget.value = next;
  return removed;
}

// 收藏条目：整段先按整行删，剩下的按单个 tag 删
function removeEntryFromPrompt(node, text) {
  let removed = 0;
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (hasBlock(node, trimmed)) {
      if (removePromptBlock(node, trimmed)) removed += 1;
      continue;
    }
    for (const tag of trimmed.split(/[,，]/).map((item) => item.trim()).filter(Boolean)) {
      removed += removeTagItem(node, tag);
    }
  }
  return removed;
}
// 新加进来的 LoRA 自动追加触发词；移除时把自动写过的那一项摘掉
function autoInsertPrompt(node, rows) {
  if (node.properties?.autoPrompt === false) return;
  if (!node.__autoRows) {
    node.__autoRows = new Set(rows.map((item) => item.name));
    node.__autoWords = new Map();
    return;
  }
  for (const [name, word] of [...node.__autoWords]) {
    if (rows.some((item) => item.name === name)) continue;
    removeBlocksContaining(node, word);
    node.__autoWords.delete(name);
    node.__autoRows.delete(name);
  }
  for (const item of rows) {
    if (node.__autoRows.has(item.name)) continue;
    node.__autoRows.add(item.name);
    const word = String(item.row.tw || "").trim();
    if (!word || containsTag(node, word)) continue;
    insertPrompt(node, word, false, false);
    node.__autoWords.set(item.name, word);
  }
}


function apply(node) {
  const lp = node.__lp;
  const props = node.properties;
  const open = props.panelOpen !== false;

  lp.root.classList.toggle("collapsed", !open);
  lp.arrow.textContent = open ? "▾" : "▸";

  const source = resolveSource(node);
  const stack = source.stack;
  const rows = collectRows(stack);
  autoInsertPrompt(node, rows);

  if (rows.length === 1 && !props.selectedLora) props.selectedLora = rows[0].name;

  updateWarn(node, source, rows);

  const tab = props.tab || "lora";
  for (const btn of lp.tabs.children) btn.classList.toggle("on", btn.dataset.tab === tab);

  // 标签页要高一点，切页时贴合一次
  if (node.__lastTab !== tab) {
    node.__lastTab = tab;
    if (open) fit(node);
  }

  lp.pageWords.style.display = open ? "flex" : "none";

  if (!open) return;
  if (tab === "lora") renderWords(node, rows);
  else if (tab === "tags") renderTags(node);
  else if (tab === "fav") renderFav(node);
  else if (tab === "fibo") renderFibo(node);
  else renderPlaceholder(node, tab);
}

let TAG_LIB = null;

async function loadTagLibrary() {
  if (TAG_LIB) return TAG_LIB;
  // 后端有新接口就用它（能实时反映 tags/zh_CN.yaml）；否则读插件目录里的静态快照
  const sources = [
    { url: "/shiyi_lora/tags", viaApi: true },
    { url: "/extensions/Shiyi-LoRA-Composer/tags.json", viaApi: false },
  ];
  let failure = "";
  for (const source of sources) {
    let res;
    try {
      res = source.viaApi
        ? await api.fetchApi(source.url, { cache: "no-store" })
        : await window.fetch(source.url, { cache: "no-store" });
    } catch (error) {
      failure = `${source.url} 无法访问`;
      continue;
    }
    const text = await res.text();
    if (!res.ok || !text.trim()) {
      failure = `${source.url} → ${res.status || "空响应"}`;
      continue;
    }
    try {
      TAG_LIB = JSON.parse(text);
      return TAG_LIB;
    } catch {
      failure = `${source.url} 返回的不是 JSON（后端未重启？）`;
    }
  }
  throw new Error(failure || "标签库不可用");
}

async function renderTags(node) {
  const lp = node.__lp;
  const props = node.properties;
  lp.pageWords.replaceChildren();
  const hint = el("div", "shiyi-lp-hint", "读取标签库…");
  lp.pageWords.appendChild(hint);

  let lib;
  try {
    lib = await loadTagLibrary();
  } catch (error) {
    hint.textContent = `读取失败：${error.message}`;
    return;
  }
  const cats = Array.isArray(lib.categories) ? lib.categories : [];
  if (!cats.length) {
    hint.textContent = lib.error || "标签库为空";
    return;
  }
  if (!props.tagCategory || !cats.some((cat) => cat.name === props.tagCategory)) {
    props.tagCategory = cats[0].name;
  }

  lp.pageWords.replaceChildren();

  const tools = el("div", "shiyi-lp-tools");
  const search = document.createElement("input");
  search.className = "shiyi-lp-search";
  search.placeholder = `搜索 ${lib.total || 0} 个标签（中/英）`;
  search.value = node.__lpTagQuery || "";
  search.addEventListener("input", () => {
    node.__lpTagQuery = search.value.trim().toLowerCase();
    renderTags(node);
    node.__lp.pageWords.querySelector(".shiyi-lp-search")?.focus();
  });
  search.addEventListener("keydown", (event) => event.stopPropagation());
  tools.appendChild(search);
  lp.pageWords.appendChild(tools);

  const chips = el("div", "shiyi-lp-chips");
  for (const cat of cats) {
    const chip = el("div", "shiyi-lp-chip" + (cat.name === props.tagCategory ? " on" : ""), cat.name);
    chip.title = `${cat.name} · ${cat.count} 个标签`;
    chip.onclick = () => {
      props.tagCategory = cat.name;
      node.__lpTagQuery = "";
      for (const group of cat.groups) node.__lp.collapsed.add(`${cat.name}/${group.name}`);
      renderTags(node);
    };
    chips.appendChild(chip);
  }
  lp.pageWords.appendChild(chips);

  const list = el("div", "shiyi-lp-list");
  lp.pageWords.appendChild(list);

  const addRow = (entry, subtitle) => {
    const row = el("div", "shiyi-lp-row");
    row.append(el("span", "shiyi-lp-tag", entry.zh || entry.tag), el("span", "shiyi-lp-en", entry.tag));
    row.title = subtitle ? `${subtitle} · ${entry.tag}` : entry.tag;
    row.onclick = () => {
      insertPrompt(node, entry.tag);
      toast(`已插入：${entry.tag}`);
    };
    return row;
  };

  const query = node.__lpTagQuery || "";
  if (query) {
    const rows = el("div", "shiyi-lp-tagrows");
    list.appendChild(rows);
    let shown = 0;
    for (const cat of cats) {
      for (const group of cat.groups) {
        for (const entry of group.tags) {
          if (!entry.tag.toLowerCase().includes(query) && !String(entry.zh).toLowerCase().includes(query)) continue;
          rows.appendChild(addRow(entry, `${cat.name} / ${group.name}`));
          shown += 1;
          if (shown >= 300) break;
        }
        if (shown >= 300) break;
      }
      if (shown >= 300) break;
    }
    if (!shown) list.appendChild(el("div", "shiyi-lp-hint", "没有匹配的标签"));
    return;
  }

  const cat = cats.find((item) => item.name === props.tagCategory) || cats[0];
  // 第一次进来先全折起来，让人一眼看到有哪些组
  if (!node.__tagsInit) {
    for (const item of cats) {
      for (const group of item.groups) lp.collapsed.add(`${item.name}/${group.name}`);
    }
    node.__tagsInit = true;
  }
  const grid = el("div", "shiyi-lp-groups");
  list.appendChild(grid);
  for (const group of cat.groups) {
    const key = `${cat.name}/${group.name}`;
    const collapsed = lp.collapsed.has(key);
    const box = el("div", "shiyi-lp-group" + (collapsed ? "" : " wide"));
    const head = el("div", "shiyi-lp-ghead");
    head.append(
      el("span", "arrow", collapsed ? "▶" : "▼"),
      el("span", "gname", group.name),
      el("span", "gcount", String(group.tags.length))
    );
    head.onclick = () => {
      // 手风琴：翻开一个组时把同分类其它组合上，不用一路滚
      for (const item of cat.groups) lp.collapsed.add(`${cat.name}/${item.name}`);
      if (collapsed) lp.collapsed.delete(key);
      renderTags(node);
    };
    box.appendChild(head);
    if (!collapsed) {
      const rows = el("div", "shiyi-lp-tagrows");
      for (const entry of group.tags) rows.appendChild(addRow(entry));
      box.appendChild(rows);
    }
    grid.appendChild(box);
  }
}

/* 收藏页 --------------------------------------------------------------- */

let FAV = null;

async function loadFavorites() {
  if (FAV) return FAV;
  const res = await api.fetchApi("/shiyi_lora/favorites", { cache: "no-store" });
  const text = await res.text();
  if (!res.ok || !text.trim()) throw new Error("收藏接口不可用（重启 ComfyUI 后生效）");
  FAV = JSON.parse(text);
  return FAV;
}

async function saveFavorites() {
  await api.fetchApi("/shiyi_lora/favorites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(FAV),
  });
}

let FAV_MENU = null;

function closeFavMenu() {
  FAV_MENU?.remove();
  FAV_MENU = null;
}

function showFavMenu(items, x, y) {
  closeFavMenu();
  const menu = el("div", "shiyi-lp-menu");
  for (const item of items) {
    const row = el("div", "item" + (item.danger ? " danger" : ""), item.label);
    row.onclick = (event) => {
      event.stopPropagation();
      closeFavMenu();
      item.run();
    };
    menu.appendChild(row);
  }
  document.body.appendChild(menu);
  menu.style.left = `${Math.min(x, window.innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - menu.offsetHeight - 8)}px`;
  FAV_MENU = menu;
  setTimeout(() => {
    document.addEventListener("click", closeFavMenu, { once: true });
    document.addEventListener("contextmenu", closeFavMenu, { once: true });
  }, 0);
}
async function renderFav(node) {
  const lp = node.__lp;
  const props = node.properties;
  lp.pageWords.replaceChildren();
  const hint = el("div", "shiyi-lp-hint", "读取收藏…");
  lp.pageWords.appendChild(hint);

  let data;
  try {
    data = await loadFavorites();
  } catch (error) {
    hint.textContent = `读取失败：${error.message}`;
    return;
  }

  const cats = data.categories || (data.categories = []);
  if (!cats.length) cats.push({ name: "常用", items: [] });
  if (!props.favCategory || !cats.some((cat) => cat.name === props.favCategory)) {
    props.favCategory = cats[0].name;
  }
  const cat = cats.find((item) => item.name === props.favCategory) || cats[0];

  lp.pageWords.replaceChildren();

  const chips = el("div", "shiyi-lp-chips");
  for (const item of cats) {
    const chip = el("div", "shiyi-lp-chip" + (item.name === props.favCategory ? " on" : ""), item.name);
    chip.title = `${item.items.length} 条`;
    chip.onclick = () => {
      props.favCategory = item.name;
      node.__favForm = false;
      node.__favEdit = null;
      node.__favNewCat = false;
      node.__favRename = false;
      renderFav(node);
    };
    chip.oncontextmenu = (event) => {
      event.preventDefault();
      event.stopPropagation();
      showFavMenu(
        [
          {
            label: "重命名分类",
            run: () => {
              props.favCategory = item.name;
              node.__favRename = true;
              node.__favNewCat = false;
              renderFav(node);
            },
          },
          { label: "删除分类", danger: true, run: () => removeCat(item) },
        ],
        event.clientX,
        event.clientY
      );
    };
    chips.appendChild(chip);
  }
  const addCat = el("div", "shiyi-lp-chip add", "＋");
  addCat.title = "新建分类";
  addCat.onclick = () => {
    node.__favNewCat = !node.__favNewCat;
    node.__favRename = false;
    renderFav(node);
  };
  chips.appendChild(addCat);
  lp.pageWords.appendChild(chips);

  const catInput = (placeholder, value, onSubmit) => {
    const input = document.createElement("input");
    input.className = "shiyi-lp-search";
    input.placeholder = placeholder;
    input.value = value || "";
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        node.__favNewCat = false;
        node.__favRename = false;
        renderFav(node);
        return;
      }
      if (event.key === "Enter") onSubmit(input.value.trim());
    });
    setTimeout(() => input.focus(), 0);
    return input;
  };

  if (node.__favNewCat) {
    lp.pageWords.appendChild(
      catInput("新分类名，回车创建", "", async (name) => {
        if (!name) return;
        if (!cats.some((item) => item.name === name)) data.categories.push({ name, items: [] });
        props.favCategory = name;
        node.__favNewCat = false;
        await saveFavorites();
        renderFav(node);
      })
    );
  }
  if (node.__favRename) {
    lp.pageWords.appendChild(
      catInput(`把「${cat.name}」改成…`, cat.name, async (name) => {
        if (name && name !== cat.name) {
          cat.name = name;
          props.favCategory = name;
        }
        node.__favRename = false;
        await saveFavorites();
        renderFav(node);
      })
    );
  }

  const search = document.createElement("input");
  search.className = "shiyi-lp-search";
  search.placeholder = "搜索收藏条目（名称或内容）";
  search.value = node.__favQuery || "";
  search.addEventListener("input", () => {
    node.__favQuery = search.value.trim().toLowerCase();
    renderFav(node);
    node.__lp.pageWords.querySelector(".shiyi-lp-search")?.focus();
  });
  search.addEventListener("keydown", (event) => event.stopPropagation());
  lp.pageWords.appendChild(search);

  const tools = el("div", "shiyi-lp-favbar");
  const meta = el("span", "shiyi-lp-meta", "");
  const addBtn = el("button", "shiyi-lp-btn", node.__favForm && !node.__favEdit ? "取消" : "＋ 添加");
  addBtn.onclick = () => {
    const opening = !(node.__favForm && !node.__favEdit);
    node.__favForm = opening;
    node.__favEdit = null;
    renderFav(node);
  };
  function undo(snapshot, label) {
    toast(`已删除：${label}`, {
      label: "撤销",
      run: async () => {
        FAV = snapshot;
        await saveFavorites();
        toast("已恢复");
        renderFav(node);
      },
    });
  };

  async function removeCat(target) {
    const snapshot = JSON.parse(JSON.stringify(data));
    data.categories = cats.filter((item) => item !== target);
    if (!data.categories.length) data.categories.push({ name: "常用", items: [] });
    props.favCategory = data.categories[0].name;
    node.__favForm = false;
    node.__favEdit = null;
    await saveFavorites();
    undo(snapshot, `分类 ${target.name}`);
    renderFav(node);
  };
  meta.textContent = `${cat.items.length} 条`;
  tools.append(addBtn, meta);
  lp.pageWords.appendChild(tools);

  if (node.__favForm) {
    const editing = node.__favEdit;
    const item = editing ? cat.items[editing.index] : null;
    const form = el("div", "shiyi-lp-form");
    const nameInput = document.createElement("input");
    nameInput.className = "shiyi-lp-search";
    nameInput.placeholder = "名称（留空取首行）";
    nameInput.value = item?.name || "";
    const textInput = document.createElement("textarea");
    textInput.className = "shiyi-lp-textarea";
    textInput.rows = 3;
    textInput.placeholder = "粘贴 tag 或整段，一行一段";
    textInput.value = item?.text || "";
    const saveBtn = el("button", "shiyi-lp-btn primary", item ? "保存修改" : `保存到「${cat.name}」`);
    saveBtn.onclick = async () => {
      const text = textInput.value.trim();
      if (!text) {
        toast("内容不能为空");
        return;
      }
      const name = nameInput.value.trim() || text.split("\n")[0].slice(0, 24);
      if (item) {
        item.name = name;
        item.text = text;
      } else {
        cat.items.unshift({ name, text });
      }
      await saveFavorites();
      node.__favForm = false;
      node.__favEdit = null;
      toast(item ? "已修改" : "已保存");
      renderFav(node);
    };
    for (const input of [nameInput, textInput]) {
      input.addEventListener("keydown", (event) => event.stopPropagation());
    }
    form.append(nameInput, textInput, saveBtn);
    lp.pageWords.appendChild(form);
  }

  const list = el("div", "shiyi-lp-list");
  lp.pageWords.appendChild(list);

  const query = node.__favQuery || "";
  const source = query
    ? cats.flatMap((item) =>
        item.items.map((entry) => ({ entry, catName: item.name, cat: item }))
      ).filter(
        ({ entry }) =>
          entry.name.toLowerCase().includes(query) || entry.text.toLowerCase().includes(query)
      )
    : cat.items.map((entry) => ({ entry, catName: cat.name, cat }));

  meta.textContent = query ? `${source.length} / ${cat.items.length} 条` : `${cat.items.length} 条`;
  if (!source.length) {
    list.appendChild(
      el("div", "shiyi-lp-hint", query ? "没有匹配的条目" : "这个分类还没有条目，点「＋ 添加」")
    );
    return;
  }

  const rows = el("div", "shiyi-lp-favlist");
  list.appendChild(rows);
  for (const { entry, catName, cat: owner } of source) {
    const row = el("div", "shiyi-lp-favrow");
    const info = el("div", "shiyi-lp-favinfo");
    const title = el("div", "n", entry.name);
    if (query) title.append(el("span", "cat", ` · ${catName}`));
    info.append(title, el("div", "t", entry.text));
    const removeEntry = async () => {
      const snapshot = JSON.parse(JSON.stringify(data));
      owner.items = owner.items.filter((item) => item !== entry);
      await saveFavorites();
      undo(snapshot, entry.name);
      renderFav(node);
    };
    row.append(info);
    row.oncontextmenu = (event) => {
      event.preventDefault();
      event.stopPropagation();
      showFavMenu(
        [
          {
            label: "插入到提示词",
            run: () => {
              if (insertPrompt(node, entry.text, entry.text.includes("\n"))) toast(`已插入：${entry.name}`);
              else toast("提示词里已经有了");
            },
          },
          {
            label: "从提示词移除",
            run: () => {
              const count = removeEntryFromPrompt(node, entry.text);
              toast(count ? `已移除 ${count} 处` : "提示词里没有这些内容");
            },
          },
          {
            label: "编辑",
            run: () => {
              node.__favEdit = { index: owner.items.indexOf(entry) };
              node.__favForm = true;
              props.favCategory = owner.name;
              renderFav(node);
            },
          },
          { label: "删除", danger: true, run: removeEntry },
        ],
        event.clientX,
        event.clientY
      );
    };
    row.title = entry.text;
    row.onclick = () => {
      if (insertPrompt(node, entry.text, entry.text.includes("\n"))) toast(`已插入：${entry.name}`);
      else toast("提示词里已经有了");
    };
    rows.appendChild(row);
  }
}

/* Fibo 编辑页 ---------------------------------------------------------- */

const FIBO_FIELDS = [
  ["short_description", "摘要"],
  ["objects", "对象"],
  ["background_setting", "背景"],
  ["lighting", "光照"],
  ["aesthetics", "美学"],
  ["photographic_characteristics", "摄影"],
  ["style_medium", "媒介"],
  ["text_render", "画面文字"],
  ["context", "用途"],
  ["artistic_style", "艺术风格"],
  ["edit_instruction", "编辑指令"],
];

const FIBO_REQUIRED = ["short_description", "background_setting", "lighting", "aesthetics", "context"];

const FIBO_VLM_MODELS = [
  ["qwen3-vl:8b", "qwen3-vl:8b（快）"],
  ["qwen3-vl:30b-a3b", "qwen3-vl:30b-a3b（准）"],
  ["huihui_ai/qwen3-vl-abliterated:8b", "qwen3-vl-abliterated 8b"],
];

const FIBO_HELP = [
  ["short_description", "摘要", "整图摘要，≤200 词。写最终画面：主体 + 动作 + 环境 + 光线 + 氛围。描述结果，不写“去掉了什么”。"],
  ["objects", "对象", "主体/物体，≤5 个。每项必填 description（≤100 词）、location（center / top-left / bottom-right foreground）、relationship；可选 relative_size、shape_and_color、texture、appearance_details、orientation。人物可加 pose / expression / clothing / action / gender / skin_tone_and_texture。"],
  ["background_setting", "背景", "环境、地点、背景里的所有元素。没写进 objects 的东西都放这里，不要重复。"],
  ["lighting", "光照", "conditions（bright daylight / golden hour / studio lighting）+ direction（front-lit / backlit / side-lit from left）+ shadows（long soft shadows / sharp shadows / minimal shadows）。"],
  ["aesthetics", "美学", "composition（rule of thirds / centered / close-up / medium shot）+ color_scheme（warm complementary / monochromatic blue）+ mood_atmosphere（serene / energetic / mysterious）。"],
  ["photographic_characteristics", "摄影", "depth_of_field（shallow / deep / bokeh）+ focus（sharp focus on subject / soft focus / motion blur）+ camera_angle（eye-level / low angle / high angle）+ lens_focal_length（35mm / 85mm portrait / macro）。"],
  ["style_medium", "媒介", "photograph / oil painting / digital illustration / anime / 3D render / watercolor / pencil sketch / pixel art / vector art。不写默认按照片处理。"],
  ["text_render", "画面文字", "每段文字一项：text（精确内容，不要占位符）+ location + size（small / medium / large）+ color + font（bold sans-serif / serif / handwritten）；可选 appearance_details。没有文字就别写。"],
  ["context", "用途", "这张图是什么用途：e-commerce product shot / magazine editorial / concept art for a game / social media post。"],
  ["artistic_style", "艺术风格", "最多 3 个词：realistic / impressionistic, vibrant, textured / minimalist, flat。照片默认 realistic。"],
  ["edit_instruction", "编辑指令", "一句祈使句，动词开头：Add / Change / Make / Move / Remove / Render / Turn / Zoom。不要提“原图/参考图”；多图用 <image_1>、<image_2> 指代。"],
];

function fiboSkeleton(key) {
  const skeletons = {
    short_description: "",
    objects: [{ description: "", location: "", relationship: "" }],
    background_setting: "",
    lighting: { conditions: "", direction: "", shadows: "" },
    aesthetics: { composition: "", color_scheme: "", mood_atmosphere: "" },
    photographic_characteristics: { depth_of_field: "", focus: "", camera_angle: "", lens_focal_length: "" },
    style_medium: "photograph",
    text_render: [{ text: "", location: "", size: "medium", color: "white", font: "sans-serif" }],
    context: "",
    artistic_style: "realistic",
    edit_instruction: "",
  };
  return JSON.parse(JSON.stringify(skeletons[key] ?? ""));
}

function fiboTextWidget(node) {
  return node.widgets?.find((item) => item.name === "text") || null;
}

function readFiboText(node) {
  const widget = fiboTextWidget(node);
  return String(widget?.element ? widget.element.value : widget?.value || "");
}

function writeFiboText(node, text, focusEnd = true) {
  const widget = fiboTextWidget(node);
  if (!widget) {
    toast("这个节点没有 text 输入");
    return false;
  }
  const area = widget.element;
  if (area) {
    area.value = text;
    if (focusEnd) {
      area.selectionStart = area.selectionEnd = text.length;
    } else {
      area.selectionStart = area.selectionEnd = 0;
      area.scrollTop = 0;
    }
    area.dispatchEvent(new Event("input", { bubbles: true }));
    area.focus();
  }
  widget.value = text;
  return true;
}

const FIBO_TOP_ORDER = ["short_description", "objects", "edit_instruction", "background_setting", "lighting", "aesthetics", "photographic_characteristics", "style_medium", "text_render", "context", "artistic_style"];
const FIBO_OBJECT_ORDER = ["description", "clothing", "pose", "expression", "action", "location", "relationship", "relative_size", "shape_and_color", "texture", "appearance_details", "orientation", "gender", "skin_tone_and_texture"];

function fiboOrdered(value, order) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const out = {};
  for (const key of order) if (Object.prototype.hasOwnProperty.call(value, key)) out[key] = value[key];
  for (const key of Object.keys(value)) if (!(key in out)) out[key] = value[key];
  return out;
}

function formatCaptionForEdit(caption) {
  const ordered = fiboOrdered(caption, FIBO_TOP_ORDER);
  const parts = [];
  for (const key of Object.keys(ordered)) {
    const value = ordered[key];
    if (key === "objects" && Array.isArray(value)) {
      const items = value.map((item) => "    " + JSON.stringify(fiboOrdered(item, FIBO_OBJECT_ORDER), null, 2).replace(/\n/g, "\n    "));
      parts.push(`  "objects": [\n${items.join(",\n\n")}\n  ]`);
    } else {
      parts.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value, null, 2).replace(/\n/g, "\n  ")}`);
    }
  }
  return `{\n${parts.join(",\n\n")}\n}`;
}

function parseFiboJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch (_) {}
  return null;
}

function fiboBlank(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return !value.trim();
  if (Array.isArray(value)) return value.length === 0 || value.every(fiboBlank);
  if (typeof value === "object") return Object.keys(value).length === 0 || Object.values(value).every(fiboBlank);
  return false;
}

function fiboStatus(node) {
  const text = readFiboText(node).trim();
  if (!text) return "空文本框：点下面「最小编辑」开始";
  const caption = parseFiboJson(text);
  if (caption === null) return "当前文本不是合法 JSON；模板会覆盖，字段按钮不会动它";
  const missing = FIBO_REQUIRED.filter((key) => fiboBlank(caption[key]));
  if (fiboBlank(caption.edit_instruction)) missing.push("edit_instruction");
  const total = Object.keys(caption).length;
  return missing.length ? `${total} 个字段；缺：${missing.join("、")}` : `${total} 个字段；必填齐全`;
}

function fiboTemplate(kind) {
  if (kind === "min") return { short_description: "", edit_instruction: "" };
  if (kind === "remove") {
    return {
      short_description: "A ... scene with ..., the scene is empty and no people are present.",
      background_setting: "",
      lighting: { conditions: "", direction: "", shadows: "" },
      aesthetics: { composition: "", color_scheme: "", mood_atmosphere: "" },
      style_medium: "photograph",
      edit_instruction: "Remove the ... from the scene, leaving the empty background.",
    };
  }
  if (kind === "background") {
    return {
      short_description: "The same subject in a new setting: ...",
      objects: [{ description: "the main subject", location: "center", relationship: "in the foreground" }],
      background_setting: "",
      lighting: { conditions: "", direction: "", shadows: "" },
      aesthetics: { composition: "", color_scheme: "", mood_atmosphere: "" },
      style_medium: "photograph",
      edit_instruction: "Change the background to ...",
    };
  }
  if (kind === "style") {
    return {
      short_description: "The same scene rendered as ...",
      background_setting: "",
      lighting: { conditions: "", direction: "", shadows: "" },
      aesthetics: { composition: "", color_scheme: "", mood_atmosphere: "" },
      style_medium: "oil painting",
      artistic_style: "impressionistic, vibrant, textured",
      edit_instruction: "Turn the image into the oil painting style.",
    };
  }
  return {
    short_description: "",
    objects: [{ description: "", location: "", relationship: "" }],
    background_setting: "",
    lighting: { conditions: "", direction: "", shadows: "" },
    aesthetics: { composition: "", color_scheme: "", mood_atmosphere: "" },
    photographic_characteristics: { depth_of_field: "", focus: "", camera_angle: "", lens_focal_length: "" },
    style_medium: "photograph",
    context: "",
    artistic_style: "realistic",
    edit_instruction: "",
  };
}

function fiboLocate(node, key) {
  const current = readFiboText(node);
  const idx = current.indexOf(`"${key}"`);
  const area = fiboTextWidget(node)?.element;
  if (idx < 0 || !area) return false;
  area.focus();
  area.selectionStart = idx;
  area.selectionEnd = idx + key.length + 2;
  const line = current.slice(0, idx).split("\n").length - 1;
  const lh = parseFloat(getComputedStyle(area).lineHeight) || 16;
  area.scrollTop = Math.max(0, line * lh - area.clientHeight / 3);
  return true;
}

function applyFiboTemplate(node, kind) {
  const write = () => {
    writeFiboText(node, formatCaptionForEdit(fiboTemplate(kind)), false);
    node.__fiboConfirm = null;
    node.__fiboNotice = "已写入模板";
    renderFibo(node);
  };
  if (!readFiboText(node).trim()) return write();
  node.__fiboNotice = "";
  node.__fiboConfirm = { message: "覆盖当前文本？", run: write, where: "template" };
  renderFibo(node);
}

function addFiboField(node, key) {
  const current = readFiboText(node);
  const caption = parseFiboJson(current);
  if (caption === null) {
    node.__fiboNotice = "当前不是 JSON：先点模板或清空，避免误删";
    renderFibo(node);
    return;
  }
  if (Object.prototype.hasOwnProperty.call(caption, key)) {
    fiboLocate(node, key);
    node.__fiboNotice = `已定位：${key}`;
    renderFibo(node);
    return;
  }
  caption[key] = fiboSkeleton(key);
  writeFiboText(node, formatCaptionForEdit(caption));
  node.__fiboNotice = `已添加：${key}`;
  renderFibo(node);
}

function fiboConfirmBar(node) {
  const bar = el("div", "shiyi-lp-confirm");
  bar.appendChild(el("span", "", node.__fiboConfirm.message));
  const ok = el("button", "shiyi-lp-btn danger", "确认");
  ok.onclick = () => {
    const run = node.__fiboConfirm.run;
    node.__fiboConfirm = null;
    run();
  };
  const cancel = el("button", "shiyi-lp-btn", "取消");
  cancel.onclick = () => {
    node.__fiboConfirm = null;
    renderFibo(node);
  };
  bar.append(ok, cancel);
  return bar;
}

function graphLinkList(graph) {
  const links = graph?.links;
  if (!links) return [];
  if (Array.isArray(links)) return links.filter(Boolean);
  if (typeof links.values === "function") return [...links.values()];
  return Object.values(links);
}

function linkField(link, index, name) {
  return Array.isArray(link) ? link[index] : link[name];
}

function findGraphLink(graph, id) {
  const links = graph?.links;
  if (!links) return null;
  if (Array.isArray(links)) return links.find((link) => link && link[0] === id) || null;
  if (links[id]) return links[id];
  return graphLinkList(graph).find((link) => linkField(link, 0, "id") === id) || null;
}

function findReferenceImage(node) {
  const graph = node.graph || app.graph;
  const originOf = (link) => {
    let origin = graph?.getNodeById?.(linkField(link, 1, "origin_id"));
    for (let guard = 0; origin?.type === "Reroute" && guard < 8; guard++) {
      const input = (origin.inputs || [])[0];
      const inner = input?.link != null ? findGraphLink(graph, input.link) : null;
      origin = inner ? graph?.getNodeById?.(linkField(inner, 1, "origin_id")) : null;
    }
    return origin;
  };
  const imageOf = (origin) => (origin?.widgets || []).find((widget) => widget.name === "image")?.value || "";
  const resolve = (target, names) => {
    const input = (target?.inputs || []).find((item) => names.includes(item.name));
    if (!input || input.link == null) return "";
    return imageOf(originOf(findGraphLink(graph, input.link)));
  };
  const direct = (node.inputs || []).find((item) => item.name === "image" && item.link != null);
  if (direct) {
    const image = imageOf(originOf(findGraphLink(graph, direct.link)));
    if (image) return image;
  }
  const downstream = graphLinkList(graph).find(
    (link) => linkField(link, 1, "origin_id") === node.id && linkField(link, 2, "origin_slot") === 1
  );
  if (downstream) {
    const image = resolve(graph?.getNodeById?.(linkField(downstream, 3, "target_id")), ["images.image_1", "image_1"]);
    if (image) return image;
  }
  for (const other of graph?._nodes || []) {
    if (other?.type !== "TextEncodeFibo2") continue;
    const image = resolve(other, ["images.image_1", "image_1"]);
    if (image) return image;
  }
  return "";
}

async function fiboCaption(node) {
  if (node.__fiboBusy) return;
  const image = findReferenceImage(node);
  if (!image) {
    node.__fiboNotice = "没找到参考图：把 PROMPT 接到 TextEncodeFibo2，并给 images.image_1 接 LoadImage";
    renderFibo(node);
    return;
  }
  const model = node.properties?.vlmModel || FIBO_VLM_MODELS[0][0];
  node.__fiboBusy = true;
  node.__fiboStart = performance.now();
  const slow = String(model).includes("30b") ? "，30B 约 30–60 秒" : "";
  node.__fiboNotice = `反推中：${image}（${model}${slow}）…`;
  clearInterval(node.__fiboTimer);
  node.__fiboTimer = setInterval(() => updateFiboStatus(node), 100);
  renderFibo(node);
  try {
    const res = await api.fetchApi("/shiyi_lora/vgl_caption", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image, model }),
      timeoutMs: 600000,
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "反推失败");
    const caption = { ...data.caption };
    if (!Object.prototype.hasOwnProperty.call(caption, "edit_instruction")) caption.edit_instruction = "";
    writeFiboText(node, formatCaptionForEdit(caption), false);
    const elapsed = fiboElapsed(node).toFixed(1);
    node.__fiboNotice = `已反推 ${Object.keys(caption).length} 个字段（用时 ${elapsed} 秒）；把描述改成“改完后的画面”，再填 edit_instruction`;
  } catch (error) {
    const elapsed = fiboElapsed(node).toFixed(1);
    node.__fiboNotice = `反推失败：${error.message}（用时 ${elapsed} 秒）`;
  } finally {
    clearInterval(node.__fiboTimer);
    node.__fiboTimer = null;
    node.__fiboBusy = false;
    node.__fiboStart = null;
    renderFibo(node);
  }
}

async function fiboCaptionPrecise(node) {
  if (node.__fiboBusy) return;
  const image = findReferenceImage(node);
  if (!image) {
    node.__fiboNotice = "没找到参考图：把 IMAGE 接到懒人节点的 image 输入，或让 PROMPT 接到 TextEncodeFibo2";
    renderFibo(node);
    return;
  }
  node.__fiboBusy = true;
  node.__fiboStart = performance.now();
  node.__fiboNotice = `精细反推：JoyCaption 描述中（${image}）…`;
  clearInterval(node.__fiboTimer);
  node.__fiboTimer = setInterval(() => updateFiboStatus(node), 100);
  renderFibo(node);
  try {
    const res1 = await api.fetchApi("/shiyi_lora/joycaption", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image }),
      timeoutMs: 600000,
    });
    const data1 = await res1.json();
    if (!data1.ok) throw new Error(data1.error || "JoyCaption 失败");
    node.__fiboNotice = "精细反推：结构化+翻译中（qwen2.5:7b）…";
    updateFiboStatus(node);
    const res2 = await api.fetchApi("/shiyi_lora/vgl_structure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: data1.caption }),
      timeoutMs: 300000,
    });
    const data2 = await res2.json();
    if (!data2.ok) throw new Error(data2.error || "结构化失败");
    const caption = { ...data2.caption };
    if (!Object.prototype.hasOwnProperty.call(caption, "edit_instruction")) caption.edit_instruction = "";
    writeFiboText(node, formatCaptionForEdit(caption), false);
    const elapsed = fiboElapsed(node).toFixed(1);
    node.__fiboNotice = `精细反推完成（用时 ${elapsed} 秒）；改 edit_instruction 即可`;
  } catch (error) {
    const elapsed = fiboElapsed(node).toFixed(1);
    node.__fiboNotice = `精细反推失败：${error.message}（用时 ${elapsed} 秒）`;
  } finally {
    clearInterval(node.__fiboTimer);
    node.__fiboTimer = null;
    node.__fiboBusy = false;
    node.__fiboStart = null;
    renderFibo(node);
  }
}

function fiboElapsed(node) {
  return node.__fiboStart ? (performance.now() - node.__fiboStart) / 1000 : 0;
}

function updateFiboStatus(node) {
  const status = node.__fiboStatusEl;
  if (!status) return;
  status.replaceChildren(
    document.createTextNode(`${node.__fiboBaseStatus || ""}${node.__fiboNotice ? `　·　${node.__fiboNotice}` : ""}`)
  );
  if (node.__fiboBusy && node.__fiboStart) {
    status.appendChild(el("span", "shiyi-lp-timer", ` · ${fiboElapsed(node).toFixed(1)}s`));
  }
}

function renderFibo(node) {
  const lp = node.__lp;
  lp.pageWords.replaceChildren();

  const status = el("div", "shiyi-lp-hint");
  status.style.textAlign = "left";
  status.style.padding = "2px 2px";
  node.__fiboStatusEl = status;
  node.__fiboBaseStatus = fiboStatus(node);
  lp.pageWords.appendChild(status);
  updateFiboStatus(node);

  const tpl = el("div", "shiyi-lp-chips");
  for (const [kind, label] of [["min", "最小编辑"], ["full", "完整编辑"], ["remove", "去物"], ["background", "改背景"], ["style", "换风格"]]) {
    const chip = el("div", "shiyi-lp-chip", label);
    chip.onclick = () => applyFiboTemplate(node, kind);
    tpl.appendChild(chip);
  }
  lp.pageWords.appendChild(tpl);

  if (node.__fiboConfirm && node.__fiboConfirm.where !== "actions") {
    lp.pageWords.appendChild(fiboConfirmBar(node));
  }

  const list = el("div", "shiyi-lp-list");
  const caption = parseFiboJson(readFiboText(node)) || {};

  const fields = el("div", "shiyi-lp-chips");
  for (const [key, label] of FIBO_FIELDS) {
    const has = Object.prototype.hasOwnProperty.call(caption, key);
    const chip = el("div", "shiyi-lp-chip notranslate" + (has ? " on" : ""), label);
    chip.dataset.field = key;
    chip.setAttribute("translate", "no");
    chip.onclick = () => addFiboField(node, key);
    fields.appendChild(chip);
  }
  list.appendChild(fields);

  const reverse = el("div", "shiyi-lp-tools");
  reverse.style.display = "flex";
  reverse.style.gap = "6px";
  reverse.style.flexWrap = "wrap";
  reverse.style.padding = "2px 0";
  const captionBtn = el("button", "shiyi-lp-btn", node.__fiboBusy ? "反推中…" : "反推参考图");
  captionBtn.disabled = !!node.__fiboBusy;
  captionBtn.onclick = () => fiboCaption(node);
  const preciseBtn = el("button", "shiyi-lp-btn", node.__fiboBusy ? "精细反推中…" : "精细反推");
  preciseBtn.disabled = !!node.__fiboBusy;
  preciseBtn.title = "JoyCaption 详细描述 → qwen2.5:7b 结构化+翻译";
  preciseBtn.onclick = () => fiboCaptionPrecise(node);
  const modelSel = document.createElement("select");
  modelSel.className = "shiyi-lp-select notranslate";
  modelSel.setAttribute("translate", "no");
  modelSel.title = "仅「反推参考图」使用";
  for (const [value, label] of FIBO_VLM_MODELS) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    if (value === (node.properties?.vlmModel || FIBO_VLM_MODELS[0][0])) option.selected = true;
    modelSel.appendChild(option);
  }
  modelSel.onchange = () => {
    node.properties.vlmModel = modelSel.value;
  };
  modelSel.onkeydown = (event) => event.stopPropagation();
  reverse.append(captionBtn, preciseBtn, modelSel);
  list.appendChild(reverse);

  const actions = el("div", "shiyi-lp-tools");
  actions.style.display = "flex";
  actions.style.gap = "6px";
  actions.style.padding = "2px 0";
  const check = el("button", "shiyi-lp-btn", "检查必填");
  check.onclick = () => {
    const current = parseFiboJson(readFiboText(node));
    if (current === null) {
      node.__fiboNotice = "当前文本不是合法 JSON";
      renderFibo(node);
      return;
    }
    const missing = FIBO_REQUIRED.filter((key) => fiboBlank(current[key]));
    if (fiboBlank(current.edit_instruction)) missing.push("edit_instruction");
    node.__fiboNotice = missing.length ? `缺：${missing.join("、")}` : "必填字段齐全";
    renderFibo(node);
  };
  const tidy = el("button", "shiyi-lp-btn", "整理 JSON");
  tidy.onclick = () => {
    const current = parseFiboJson(readFiboText(node));
    if (current === null) {
      node.__fiboNotice = "当前文本不是合法 JSON";
      renderFibo(node);
      return;
    }
    writeFiboText(node, formatCaptionForEdit(current), false);
    node.__fiboNotice = "已整理 JSON";
    renderFibo(node);
  };
  const clear = el("button", "shiyi-lp-btn danger", "清空");
  clear.onclick = () => {
    if (!readFiboText(node).trim()) return;
    node.__fiboConfirm = {
      message: "清空文本框？",
      where: "actions",
      run: () => {
        writeFiboText(node, "");
        node.__fiboNotice = "已清空";
        renderFibo(node);
      },
    };
    renderFibo(node);
  };
  if (node.__fiboConfirm?.where === "actions") {
    list.appendChild(fiboConfirmBar(node));
  } else {
    actions.append(check, tidy, clear);
    list.appendChild(actions);
  }

  const tip = el("div", "shiyi-lp-hint",
    "编辑最小集：short_description + edit_instruction。字段值写“最终画面”，edit_instruction 用祈使句；官方 5 个必填：short_description / background_setting / lighting / aesthetics / context。反推得到的是参考图描述，编辑前要先把去掉/换掉的部分从 objects、short_description 里改掉。");
  tip.style.textAlign = "left";
  tip.style.padding = "4px 2px";
  list.appendChild(tip);

  const helpTitle = el("div", "shiyi-lp-hint", "每个字段填什么");
  helpTitle.style.textAlign = "left";
  helpTitle.style.padding = "4px 2px 2px";

  const help = el("div", "shiyi-lp-fibo-help");
  for (const [key, label, text] of FIBO_HELP) {
    const row = el("div", "shiyi-lp-fibo-row");
    row.appendChild(el("div", "shiyi-lp-fibo-k", `${label} · ${key}`));
    row.appendChild(el("div", "shiyi-lp-fibo-v", text));
    help.appendChild(row);
  }

  const helpWrap = el("div", "shiyi-lp-fibo-helpwrap");
  helpWrap.append(helpTitle, help);
  lp.pageWords.appendChild(list);
  lp.pageWords.appendChild(helpWrap);
}

function renderPlaceholder(node, tab) {
  const lp = node.__lp;
  lp.pageWords.replaceChildren();
  const box = el("div", "shiyi-lp-empty");
  box.appendChild(el("div", "t", tab === "tags" ? "常用 tag" : "收藏"));
  box.appendChild(el("div", "d", "预留页：数据源与交互待定"));
  lp.pageWords.appendChild(box);
}

function updateWarn(node, source, rows) {
  const lp = node.__lp;
  const existing = lp.body.querySelector(".shiyi-lp-warn");
  const unlinked = source.stack && !source.linked;
  const wrongSlot = source.linked && source.outSlot != null && source.outSlot !== 3;
  if (!unlinked && !wrongSlot) {
    existing?.remove();
    return;
  }
  const message = unlinked
    ? "未接到 triggers：触发词不会进入编码"
    : "接的是 TRIGGERS（扁平表）：勾选不生效，改接 TRIGGER_GROUPS";
  const buttonText = unlinked ? "连接触发词" : "改接 TRIGGER_GROUPS";

  if (existing) {
    if (existing.dataset.mode === (unlinked ? "unlinked" : "slot")) return;
    existing.remove();
  }
  const bar = el("div", "shiyi-lp-warn");
  bar.dataset.mode = unlinked ? "unlinked" : "slot";
  const text = el("span", "", message);
  const btn = el("button", "shiyi-lp-btn", buttonText);
  btn.onclick = () => {
    if (connectStack(node, 3)) {
      apply(node);
      fit(node);
    }
  };
  bar.append(text, btn);
  lp.body.insertBefore(bar, lp.body.firstChild);
}

/* TXT 页 --------------------------------------------------------------- */

/* 说明子页面 ------------------------------------------------------------ */

// 后端旧版没有 sections 时，前端按同一规则自己切段
function looksLikeTags(text) {
  if (!String(text).includes(",") || !/[A-Za-z]{2,}/.test(text)) return false;
  return String(text).split(",").filter((part) => part.trim()).length >= 2;
}

function isHeading(line) {
  if (line.length > 40) return false;
  if (/[：:]$/.test(line)) return true;
  return line.length <= 16 && !/[A-Za-z]{4,}/.test(line) && !/[,，]/.test(line);
}

function parseSections(text) {
  const out = [];
  let title = null;
  let buf = [];
  const flush = () => {
    const body = buf.join(" ").trim();
    if (title !== null && body) {
      const isTrigger = /触发词|trigger/i.test(title);
      if (isTrigger || looksLikeTags(body)) {
        out.push({ title, text: body, negative: /否定|negative/i.test(title) });
      }
    }
    title = null;
    buf = [];
  };
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (isHeading(line)) {
      flush();
      title = line.replace(/[：:\s]+$/, "").trim();
      continue;
    }
    if (title === null) continue;
    buf.push(line);
  }
  flush();
  return out;
}

/* 触发词页 ------------------------------------------------------------- */

// LoRA 行下面内联展开的说明段落
function docBlock(node, item) {
  const box = el("div", "shiyi-lp-doc");
  box.appendChild(el("div", "shiyi-lp-hint", "读取说明…"));
  getInfo(item.name)
    .then((info) => {
      const list =
        Array.isArray(info.sections) && info.sections.length
          ? info.sections
          : parseSections(info.description);
      box.replaceChildren();
      if (!list.length) {
        box.appendChild(
          el("div", "shiyi-lp-hint", info.description ? "这个 txt 没有可插入的段落" : "没有说明文件")
        );
        return;
      }
      for (const section of list) {
        const on = hasBlock(node, section.text);
        const line = el("div", "shiyi-lp-doc-sec" + (on ? " on" : ""));
        const head = el("div", "shiyi-lp-doc-head");
        head.append(
          el("span", "t", section.title),
          el("span", "hint", on ? "已插入 · 点击移除" : "点击插入")
        );
        line.append(head, el("div", "shiyi-lp-doc-text", section.text));
        line.title = section.text;
        line.onclick = (event) => {
          event.stopPropagation();
          if (hasBlock(node, section.text)) removePromptBlock(node, section.text);
          else insertPrompt(node, section.text, true);
          apply(node);
        };
        box.appendChild(line);
      }
    })
    .catch((error) => {
      box.replaceChildren(el("div", "shiyi-lp-hint", `读取失败：${error.message}`));
    });
  return box;
}
function renderWords(node, rows) {
  const lp = node.__lp;
  const props = node.properties;
  lp.pageWords.replaceChildren();

  if (!stackFor(node)) {
    lp.pageWords.appendChild(
      el("div", "shiyi-lp-hint", "把 LoRA 编排器的 TRIGGER_GROUPS 接到 triggers")
    );
    return;
  }
  if (!rows.length) {
    lp.pageWords.appendChild(el("div", "shiyi-lp-hint", "编排器里还没有启用的 LoRA"));
    return;
  }

  const list = el("div", "shiyi-lp-list");
  lp.pageWords.appendChild(list);

  const groups = new Map();
  for (const item of rows) {
    const key = item.folder || "(根目录)";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  for (const [folder, items] of groups) {
    const collapsed = lp.collapsed.has(folder);
    const box = el("div", "shiyi-lp-group");
    const head = el("div", "shiyi-lp-ghead");
    head.append(el("span", "arrow", collapsed ? "▶" : "▼"), el("span", "gname", folder));
    head.onclick = () => {
      if (collapsed) lp.collapsed.delete(folder);
      else lp.collapsed.add(folder);
      apply(node);
    };
    head.oncontextmenu = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const names = items.map((item) => item.name);
      showFavMenu(
        [
          { label: `补全本组缺失（最多 8 个）`, run: () => enrichBatch(node, names) },
          {
            label: "重新读取本组信息",
            run: () => {
              names.forEach((name) => INFO_CACHE.delete(name));
              apply(node);
            },
          },
        ],
        event.clientX,
        event.clientY
      );
    };
    box.appendChild(head);

    if (collapsed) {
      list.appendChild(box);
      continue;
    }

    for (const item of items) {
      const rowEl = el("div", "shiyi-lp-row");
      if (props.selectedLora === item.name) rowEl.classList.add("open");

      const nameEl = el("span", "shiyi-lp-name", item.label);
      nameEl.title = item.name;
      const delBtn = el("span", "shiyi-lp-del", "移除");
      delBtn.title = "把提示词里含这个 LoRA 触发词的块都删掉";
      delBtn.onclick = (event) => {
        event.stopPropagation();
        const word = String(item.row.tw || "").trim();
        if (!word) {
          toast("这个 LoRA 没有触发词");
          return;
        }
        const removed = removeBlocksContaining(node, word);
        toast(removed ? `已移除 ${removed} 块` : "提示词里没有含这个词的块");
      };
      rowEl.append(nameEl, delBtn);
      rowEl.title = "点开展示说明段落，再点段落整段插入；右键可从 Civitai 补封面与说明";
      rowEl.onclick = () => {
        props.selectedLora = item.name;
        node.__docFor = node.__docFor === item.name ? null : item.name;
        apply(node);
      };
      rowEl.oncontextmenu = (event) => {
        event.preventDefault();
        event.stopPropagation();
        showFavMenu(
          [
            {
              label: "补封面与说明（Civitai）",
              run: () => enrichLora(node, item.name),
            },
            {
              label: "重新读取信息",
              run: () => {
                INFO_CACHE.delete(item.name);
                apply(node);
              },
            },
          ],
          event.clientX,
          event.clientY
        );
      };
      getInfo(item.name)
        .then((info) => {
          if (!rowEl.isConnected || !info || info.error) return;
          if (!info.has_txt) {
            const badge = el("span", "shiyi-lp-badge", "无说明");
            badge.title = "没有找到说明 txt，右键可从 Civitai 抓取";
            nameEl.after(badge);
          }
        })
        .catch(() => {});
      box.appendChild(rowEl);
      if (node.__docFor === item.name) box.appendChild(docBlock(node, item));
    }
    list.appendChild(box);
  }
}


function signature(node) {
  const stack = stackFor(node);
  const props = node.properties || {};
  const linkId = triggersInput(node)?.link ?? "none";
  const base = `${props.page}|${props.panelOpen}|${props.selectedLora}|${linkId}`;
  if (!stack) return `${base}|none`;
  const body = stack.__rows
    .map((row) => `${row.name}|${row.on === false ? 0 : 1}|${row.tw || ""}`)
    .join("\n");
  return `${base}|${body}`;
}

function panelHeight(node) {
  if (node.properties?.panelOpen === false) return PANEL_H_CLOSED;
  if (node.properties?.tab === "tags" || node.properties?.tab === "fav") return PANEL_H_TAGS;
  if (node.properties?.tab === "fibo") return PANEL_H_FIBO;
  return PANEL_H_OPEN;
}

// 内容高度：原版 text 的 minNodeSize + 面板当前高度
function targetHeight(node) {
  const textW = node.widgets?.find((widget) => widget.name === "text");
  const textMin = textW?.options?.minNodeSize?.[1] ?? 200;
  return Math.max(200, textMin) + panelHeight(node) + 10;
}

function fit(node) {
  const width = Math.max(400, node.size?.[0] || 400);
  node.setSize([width, targetHeight(node)]);
}

function normalizeHidden(node) {
  // 旧工作流里这两个隐藏 widget 存过空串，纠正回默认值，重新保存后工作流就干净了
  const pos = node.widgets?.find((item) => item.name === "position");
  if (pos && pos.value !== "before" && pos.value !== "after") pos.value = "before";
  const dedupe = node.widgets?.find((item) => item.name === "dedupe");
  if (dedupe && typeof dedupe.value !== "boolean") dedupe.value = true;
}

function attach(node) {
  normalizeHidden(node);
  for (const name of ["group_state", "position", "dedupe"]) {
    const widget = node.widgets?.find((item) => item.name === name);
    if (!widget) continue;
    widget.type = "hidden";
    widget.computeSize = () => [0, -4];
    if (widget.element) widget.element.style.display = "none";
  }

  ensurePanel(node);
  apply(node);
  fit(node);
  node.__lpSig = signature(node);

  node.onDrawForeground = function () {
    if (this.flags?.collapsed) return;
    const sig = signature(this);
    if (sig !== this.__lpSig) {
      this.__lpSig = sig;
      apply(this);
    }
  };

  node.getExtraMenuOptions = function (_, options) {
    const positionW = this.widgets?.find((item) => item.name === "position");
    const dedupeW = this.widgets?.find((item) => item.name === "dedupe");
    options.push(
      {
        content: this.properties?.panelOpen === false ? "展开触发词面板" : "收起触发词面板",
        callback: () => {
          this.properties.panelOpen = this.properties?.panelOpen === false;
          apply(this);
          fit(this);
        },
      },
      {
        content: `触发词放在正文${positionW?.value === "after" ? "后" : "前"}（点击切换）`,
        callback: () => {
          if (!positionW) return;
          positionW.value = positionW.value === "after" ? "before" : "after";
          this.setDirtyCanvas(true, true);
        },
      },
      {
        content: `提示词去重：${dedupeW?.value === false ? "关" : "开"}（点击切换）`,
        callback: () => {
          if (!dedupeW) return;
          dedupeW.value = dedupeW.value === false;
          this.setDirtyCanvas(true, true);
        },
      },
      {
        content: `加 LoRA 时自动写入提示词：${this.properties?.autoPrompt === false ? "关" : "开"}（点击切换）`,
        callback: () => {
          this.properties.autoPrompt = this.properties?.autoPrompt === false;
          this.__autoRows = null;
          this.setDirtyCanvas(true, true);
        },
      }
    );
  };
}

app.registerExtension({
  name: "shiyi.lora.clip",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onNodeCreated?.apply(this, arguments);
      attach(this);
      fit(this);
      setTimeout(() => {
        fit(this);
        this.setDirtyCanvas(true, true);
      }, 60);
      setTimeout(() => fit(this), 160);
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      onConfigure?.apply(this, arguments);
      this.__lpSig = signature(this);
      this.__autoRows = null;
      this.__autoWords = null;
      apply(this);
      fit(this);
      this.setDirtyCanvas(true, true);
      setTimeout(() => {
        normalizeHidden(this);
        ensurePanel(this);
        apply(this);
        fit(this);
      }, 0);
      setTimeout(() => fit(this), 120);
    };
  },
});

window.__shiyiClip = { stackFor, collectRows, signature };






























































