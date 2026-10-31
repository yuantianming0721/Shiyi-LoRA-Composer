# Shiyi LoRA Composer · 懒人节点包

四颗 ComfyUI 自定义节点，把「选模型 → 堆 LoRA → 写提示词」这三件重复劳动各收进一个面板，不用再在画布上串一长排 loader 和一叠 note。

- **模型加载器** — Checkpoint / UNet / GGUF 一个下拉搞定；自动认出模型自带的 CLIP / VAE，缺哪个才让你补；面板直接给架构、精度或量化、体积、缩略图
- **LoRA 编排器** — 一个节点套 N 个 LoRA，每个 LoRA 的说明段落和触发词就在面板里，点一下插进提示词
- **CLIP 文本编码** — 原生 textarea 不动，下方挂「便携提示词添加」：LoRA 说明 / 常用 tag / 收藏 / Fibo 编辑 四个标签页
- **触发词并入提示词** — 纯字符串版，去重后塞进正文前或后

中文界面、深色紧凑、不弹窗挡视野；删除带撤销，条目操作走右键菜单。

## 特性

| | |
|---|---|
| 模型来源统一 | checkpoint、`diffusion_models`、`unet`、`.gguf` 混在一个列表里按目录分组 |
| 自动补 CLIP / VAE | 读张量前缀判内置（`conditioner.` / `te.` / `first_stage_model.` / `vae.` …），内置优先，缺的才用手选 |
| `clip_type` 自动 | 按架构推导 `krea2` / `qwen_image` / `flux` / `moss_image` / `ltxv` …，也能手动覆盖 |
| 元数据直读 | 只读 safetensors / GGUF 头部，不加载权重就能给出精度、张量数、架构，并标注判断来源（元数据 / 文件名 / 张量名） |
| 缩略图 | 认 `<名字>.preview.png`、`<名字>.png`、`.assets/preview.png` |
| 提示词两粒度 | 单个 tag 用逗号接成一行；LoRA 说明整段独占一行 |
| 本地词库 | 内置 3,981 条中文 Danbooru 标签，11 分类 150 组，可搜索 |
| 收藏夹 | 自建分类与条目，增删改查齐全，删除可撤销 |
| 触发词持久化 | 存在 `triggers.json`，跟 LoRA 走，重载工作流不丢 |
| 缺封面自动补 | 右键 LoRA 从 Civitai 按哈希取封面与说明；分组右键可批量补 |

## 安装

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/yuantianming0721/Shiyi-LoRA-Composer
```

或下载 zip 解压到 `custom_nodes/`（应得到 `custom_nodes/Shiyi-LoRA-Composer/`），重启 ComfyUI，前端再 Ctrl+F5 一次。

可选：**ComfyUI-GGUF** —— 只在要加载 `.gguf` 时需要。
可选：把 `config.example.json` 复制成 `config.json`，按需改 LoRA 扫描目录。

**LoRA 目录**：默认只扫 ComfyUI 自己的 `models/loras`。要同时列出 Forge / WebUI 的 LoRA，在 `config.json` 里填 `lora_roots`（数组，绝对路径）：

```json
{
  "lora_roots": ["D:/path/to/sd-webui-forge/models/Lora"],
  "default_strength": 0.8,
  "scan_ttl": 30,
  "auto_trigger": true
}
```

## 四个节点

| 节点 | 作用 |
|---|---|
| **模型加载器（Checkpoint / UNet / GGUF）** | 一个入口选三种分发方式；面板显示架构、精度/量化、大小、张量数、缩略图，输出 MODEL / CLIP / VAE |
| **LoRA 编排器（多 LoRA · 说明 · 触发词）** | MODEL / CLIP → 依次套 N 个 LoRA，输出 MODEL、CLIP、TRIGGERS、TRIGGER_GROUPS |
| **CLIP 文本编码（LoRA 触发词）** | clip + 提示词 → CONDITIONING + PROMPT；原生 text 框 + 「便携提示词添加」列表（LoRA / 常用 tag / 收藏 / Fibo 编辑 四页） |
| **LoRA 触发词并入提示词** | 纯字符串版：把触发词去重后塞进正文前或后 |

## 模型加载器

三个来源共用一套面板：

| 来源 | 目录 | 说明 |
|---|---|---|
| 完整模型 | `models/checkpoints` | 一次给全 MODEL + CLIP + VAE（模型自带什么给什么，缺的就是 None） |
| UNet | `models/diffusion_models` + `models/unet` | 只给 MODEL，CLIP / VAE 用节点里的下拉另配 |
| GGUF | 同上目录里的 `.gguf` | 走 ComfyUI-GGUF 的 `UnetLoaderGGUF`，需要装该插件（CPU 模式跑不动，要 GPU） |

面板每行显示 **名称 + 精度徽标 + 文件大小**，点一行就写进「当前模型」；下方详情给 **缩略图（同目录 `<名字>.preview.png` 或 `<名字>.png`）、架构判断、格式·精度·张量数·体积、来源仓库（`.assets/manifest.json`）**。

模型列表默认按系列折叠成一行行组头（`▸ anima（10）`），点组头展开/收起，搜索时自动全部展开，面板不会被几十个模型占满。

面板高度跟着节点走：拖动节点右下角拉高，列表和说明区一起变高；拉矮到下限会被挡住，列表保留最小 130px。折叠只缩成标题栏，再展开恢复原来的高度。

三个下拉：**系列**（按子目录，带数量，切 tab 自动换成该 tab 的目录）、**类型**（按架构筛选，比如只看 anima 9 个 / Krea 2 3 个）、**排序**（名称 / 大小 / 最近修改 / 架构分组——选架构分组时列表按架构重新分组）。系列和类型可以叠加，再加搜索框三条件一起收窄。

模型旁边放 `<名字>.txt`（或 `<名字>.safetensors.txt`）就会在详情下方显示说明，默认折叠 3 行，点一下展开。说明前 200 字也会参与架构识别——作者在说明里写「Krea 2 微调」这类字就能判对。

- **自带 CLIP / VAE 一眼可见**：列表行右侧有绿色 `CLIP` / `VAE` 小标（有才显示），选中后详情底部再用 `自带 CLIP ✓` / `自带 VAE ✗` 明确标出，鼠标悬停有说明
- **自动检测内置组件**：checkpoint 里带 CLIP / VAE 就直接用内置的，缺哪个才去加载手选的 `clip_name` / `vae_name`。判定看张量前缀（CLIP：`cond_stage_model.` / `conditioner.` / `te.` / `clip_l.` / `text_encoders.`；VAE：`first_stage_model.` / `vae.`），面板详情写 `内置：CLIP ✓ / VAE ✓（都用内置）` 或 `CLIP ✗ / VAE ✗（缺的手选补）`
- **`clip_type` 默认 `auto`**：按模型架构自动选（`krea2` / `qwen_image` / `flux` / `stable_diffusion` / `moss_image` …），详情里显示 `auto → xxx`；想手动指定就改下拉
- 架构按优先级取：safetensors/gguf 元数据（`modelspec.architecture` / `base_model` / `key_layout`）→ 文件名 → 张量名特征，详情里会标出用的是哪一路（`元数据` / `按张量名推断`）
- 精度：metadata 的 `dtype_counts` → 张量 dtype 占比；GGUF 读 `GGMLQuantizationType`（Q8_0 / Q6_K / Q4_K_M …）
- `clip_type` 下拉来自 `comfy.sd.CLIPType`（38 个），选错会加载失败，按模型族选（flux → `flux`，qwen → `qwen_image`，krea2 → `krea2`）
- 新增模型文件后：面板点刷新即好；原生「当前模型」下拉要重启 ComfyUI 才会出现新条目

## 懒人的视频保存

`IMAGES` 进，视频出，命名和目录都不用自己拼。

| 输入 | 说明 |
|---|---|
| naming | 日期+时间+序号 / 日期+时间 / 日期+序号 / 时间+序号 / 日期 / 时间 / 自定义 |
| filename | 选「自定义」时生效，支持 `{date}` `{time}` `{datetime}` `{index}` 占位 |
| folder | 保存目录。留空 = output 根；填 `D:/视频/作品` 这种绝对路径就存到那里，填相对路径就挂在 output 下；支持 `{date}` 占位；只有 `..` 会被拒（防手滑） |
| format | mp4 (h264) / mp4 (h265) / webm (vp9) / gif |
| fps | 帧率，默认 24 |
| quality | CRF，0-51，越小越清晰（默认 18） |
| audio | 可选，接了就把音轨混进去（aac / opus） |

序号不是随机数：扫目标目录里同一命名模板的已有文件，取最大号 +1，所以连点几次运行就是 `0001`、`0002`、`0003`，不会覆盖。改动 naming 或 folder 会各自独立计数。

## 触发词存在哪

触发词是 **LoRA 自己的属性**，存在插件目录的 `triggers.json`（`{相对路径: 触发词}`，空串＝明确不要）：

| 位置 | 职责 |
|---|---|
| LoRA 选择器（卡片墙）底部编辑栏 | **主入口**：鼠标指向卡片 → 编辑栏出现 → 改词 → 保存（已存的卡片右上角有绿点） |
| 编排器行的 `i` 说明面板 | 次入口：点 chip / 全部填入 / 清空，同样写进 `triggers.json` |
| CLIP 面板的列表 | **只读**展示触发词；点行打开说明、点段落整段插入 |

添加 LoRA 时的取值顺序：**你存过的词** → civitai/`.txt` 自动识别 → **训练标签里出现次数最多的词**（跳过 `1girl`/`solo` 这类通用标签）→ 空。改词时，编排器里同名的行会一起同步。

说明面板（行内 `i`）底部有 **「智能添加：<词>（训练 N 次）」** 按钮：直接取 `ss_tag_frequency` 里频次最高的词加进本行并写入 `triggers.json`，同时跳过通用标签。

## 接线

```
CLIP 加载器 ──clip──┬──► LoRA 编排器 ──MODEL──► KSampler
                   │           │
                   │           ├──CLIP──────────────► CLIP 文本编码（正面）.clip
                   │           └──TRIGGER_GROUPS───► CLIP 文本编码（正面）.triggers
                   └──────────────────────────────► CLIP 文本编码（负面）.clip
```

负面那个编码器不接 `triggers` 即可（节点会提示“把 TRIGGER_GROUPS 接进来”，不影响出图）。

## CLIP 文本编码怎么用

这个节点就是**原版 CLIPTextEncode 加一块附加面板**：上面的 `text` 多行输入框保持原样（原生 widget，约 103px 高），提示词照常写。

**核心体验**：往编排器里加一个 LoRA 时，它的触发词会**自动写进 `text` 框**（追加在末尾、自动补 `, `；已经有的词不重复写）。**把 LoRA 从编排器删掉时，只摘掉它当时自动写进去的那一个词**，你手写的提示词和其它词不动。加载已有工作流时只登记、不回写，也不会在之后误删你原来的提示词。右键菜单可关：`加 LoRA 时自动写入提示词：开/关`（关掉后自动删除也一并停用）。

触发词来源两条，按顺序取：**`.txt` 里的 `触发词：`/`@词`** → **训练元数据 `ss_tag_frequency` 的最高频词**（跳过 `1girl`/`solo` 这类通用标签）→ 你在选择器里手存的词优先级最高。

面板在 `text` 下面，只有 **一个标题 + 三组标签页**：

```
▾ 便携提示词添加
  [LoRA] [常用 tag] [收藏] [Fibo 编辑]
  ▼ anima/原神
      冰之女皇                          移除
```

- **LoRA**（现状）：点某个 LoRA 那一行 → **在该行下方内联展开说明段落**（不弹窗）。段落 = 标题行（`：` 结尾）+ 下面那段标签；**点一段就把这一整段写进提示词框**（独占一行），再点一次移除。标 `否定` 的段落也会插，只是提示你它是负面用的。
- **常用 tag**：本地标签库 `tags/zh_CN.yaml`（**3,981 条 / 11 个分类 / 150 组**，中英对照）。顶部搜索（中英都能搜，跨分类）、下面一排分类 chips（人物 / 服饰 / 表情动作 / 画面 / 环境 / 场景 / 物品 / 镜头 / 汉服 / 魔法系 / 反向提示词），组名可折叠；**点某个标签就插进提示词**。数据是复制进来的，可以直接改 `tags/zh_CN.yaml`，保存后重进页面即生效（后端按文件 mtime 缓存）。
- **收藏**：自己的常用词库，存在 `favorites.json`，增删改查都在面板里完成：
  - **分类**：chips 末尾 `＋` 输入名字回车新建；**右键分类** → 重命名 / 删除
  - **条目**：`＋ 添加` 粘一串 tag 或整段 → 起名保存；每条显示**名称 + 两行内容预览**
  - **插入**：点条目（含换行的按整段插入，否则逗号接末尾）
  - **右键条目** → 插入到提示词 / 从提示词移除 / 编辑 / 删除（移除是按项删，不碰同行其它词）
  - 删除后浮层带 **「撤销」**，6 秒内可恢复
  - **搜索**：按名称或内容过滤，跨分类显示并标注所属分类
- **Fibo 编辑**：给 Fibo 2.0 的 VGL 结构化提示词用。5 个一键模板（最小编辑 / 完整编辑 / 去物 / 改背景 / 换风格）+ 11 个字段芯片；点字段把对应骨架**合并**进当前 JSON，已有字段不覆盖。底部「检查必填」按官方 5 项（`short_description` / `background_setting` / `lighting` / `aesthetics` / `context`）检查，编辑另看 `edit_instruction`。当前文本不是 JSON 时字段芯片拒绝写入，避免误删手写提示词。
- **反推参考图**：点按钮用本地 Ollama 的 `qwen3-vl:8b`（快）、`qwen3-vl:30b-a3b`（准，MoE）或 `huihui_ai/qwen3-vl-abliterated:8b` 读参考图，自动填 10 个 VGL 字段。**优先读节点自己的 `image` 输入**（把 LoadImage 的 IMAGE 直接接上来，不再靠下游连线猜），没接才回退到 `PROMPT → TextEncodeFibo2 → images.image_1`。后端 `/shiyi_lora/vgl_caption`，直连 `127.0.0.1:11434`（可用 `SHIYI_OLLAMA_URL` 覆盖）。反推得到的是参考图描述，编辑前要先把去掉/换掉的部分改掉，再填 `edit_instruction`。
- **精细反推**：一键跑两段——JoyCaption（4-bit）先写详细英文描述，再用 `qwen2.5:7b`（纯文本，快）结构化+翻译成中文 VGL。后端 `/shiyi_lora/joycaption` + `/shiyi_lora/vgl_structure`。对“白布/衣服/枕头”这类容易混的细节比单用 Qwen3-VL 更准。
- **JSON 美化**：反推/模板写入时自动按 `short_description → objects → edit_instruction → ...` 排序，顶层字段和对象之间加空行；对象里 `description / clothing / pose / expression / action` 排在前面。手动改乱了点「整理 JSON」即可重排，仍是标准 JSON，可直接跑。
- **PROMPT 输出**：这个节点的第二个输出是合并后的最终文本，可直接接 `TextEncodeFibo2.prompt`。配套工作流 `Fibo2-懒人编辑.json` 已经接好：在 Fibo 编辑页写完，点运行即可。

标签库接口：`GET /shiyi_lora/tags`（返回 `{total, categories:[{name,count,groups:[{name,color,tags:[{tag,zh}]}]}]}`）。

收藏接口：`GET /shiyi_lora/favorites` / `POST /shiyi_lora/favorites`，数据落在 `favorites.json`：

```json
{ "categories": [ { "name": "常用", "items": [ { "name": "表情", "text": "1girl, smile, looking at viewer" } ] } ] }
```

**数据流**：`tags/zh_CN.yaml` → 后端按 mtime 缓存解析 → 同时写一份静态快照 `web/tags.json`。前端优先读接口（能实时反映改过的 yaml）；后端没重启、接口不存在时自动回退读静态快照，所以刷新页面就能用。

**插入有两种粒度**：

- **单个 tag / 触发词** → 用逗号接在当前末尾：`masterpiece, 1girl, 1boy`
- **LoRA 说明里的整段** → 独占一行（换行分隔），不跟别的词挤在一起

同一段再点一次就是**移除**（按钮在「插入 / 移除」之间切换）。面板行悬停时右侧出现 **「移除」**：删掉以该触发词开头的整段行，以及同行里等于该词的那一项。

**尺寸规则**：高度不锁，随便拖；多出来的空间自动给上面那个 `text` 输入框（拖多高它就多高）。展开/收起面板时会自动贴合一次内容高度（470 / 256）。

- **收起态（默认）**：只有一条 `▸ 便携提示词添加`。
- 点这条展开成列表：
  - **说明（内联）**：点 LoRA 行就地展开这个 LoRA 的段落列表，右侧显示「点击插入 / 已插入 · 点击移除」。
  - 列表按目录分组，组头可折叠；行内显示 LoRA 名 + 只读触发词。

- 状态（展开/收起、当前页、选中项）存 `node.properties`，随工作流保存。

**没连线也能看**：面板的数据源优先取 `triggers` 连线；没连线时自动引用当前图里第一个有启用行的「LoRA 编排器」，标题条会标 `（未连线）`，展开后照样列出 LoRA 与触发词，并在顶部给一条提示 + 「连接触发词」按钮（点一下就把编排器的 `TRIGGER_GROUPS` 连到 `triggers`，触发词才会真正进入编码）。

**接错槽会被指出**：编排器有 `TRIGGERS`（扁平串）和 `TRIGGER_GROUPS`（带分组的表）两个输出。接到 `TRIGGERS` 时标题条标 `（接的是 TRIGGERS）`，并提示勾选不生效、附「改接 TRIGGER_GROUPS」按钮。

**自动选中**：图里只有一个 LoRA 时面板会直接选中它，TXT 页立刻显示内容，不用先点列表。

说明：原版 `text` widget 自带 `minNodeSize=[400,200]`，节点高度按这个下限算，所以文本域不会再被压成一行。`position`（触发词放正文前/后）与 `dedupe`（去重）不占界面，在节点右键菜单切换；`group_state` 是隐藏 widget。


## 编排器怎么用

- **+ 添加 LoRA**：弹窗是卡片墙 —— 每张卡片带预览图（懒加载）、名字、所属目录。
  - 顶部筛选：**一级目录**（`anima` / `Illustrious` / `qwen` …）→ **二级目录**（`AA画风` / `原神` / `崩铁` …），两项都带数量统计。
  - **排序**：目录+名称 / 名称 A→Z / 最近修改 / 体积从大到小 / 有预览优先。
  - `仅看有预览` 勾选框 + 搜索框（名字或路径都能搜）。
  - 单击＝替换当前行或追加新行；右键卡片＝追加为新行。
- 每行控件：
  - 左侧缩略图（跟着预览图走，未启用时半透明）
  - `✔` 勾选框：临时启用/禁用，不用拆线
  - `名字`：点一下＝换 LoRA
  - `0.80`：**点一下直接在原地输入数字**（Enter 生效 / Esc 取消 / 点输入框外也提交）；输入时 `↑ ↓` 每次 ±0.05，`Shift+↑ ↓` 每次 ±0.01。批量回 1.0 用节点右键菜单「全部权重复位 1.0」。
  - `i`：看完整说明 + 触发词候选 + 训练高频标签，点 chip 就地增删
- 触发词不再放编排行上，统一在 **CLIP 文本编码** 的 LoRA 面板里管（见下）。
- 节点右键菜单：全部启用/取消、刷新目录。
- 只有 `启用` 且该行有触发词时，才会把词并进 `TRIGGERS` / `TRIGGER_GROUPS` 输出。

## 排版说明

节点顶部按输入/输出槽数量自动留白（`16 + max(输入,输出) * 20`），标题行与第一行卡片都从 socket 区下面开始，所以不会再压到 `模型 / CLIP / TRIGGERS` 的标签上。

## 元数据来源（按优先级）

1. `<名字>.txt` —— 自己写的说明（推荐权重、副作用、`触发词：@xxx`）
2. `<名字>.metadata.json` —— civitai `trainedWords` / `base_model` / `tags`
3. safetensors 头 —— `modelspec.*`、`ss_tag_frequency`（训练高频标签）
4. `<名字>.png|jpeg|jpg|webp` —— 预览图

触发词抽取认这几种写法：`触发词：…`、`Trigger words:`、`Tags (character): …`、`人物特征：…`、`服装：…`、以及 `@xxx` 形式的风格触发词。

## LoRA 没有封面 / 说明怎么办

面板读的是 LoRA 文件**同目录**的旁挂文件，两种命名都认（`xxx` 指去掉扩展名的文件名）：

| 旁挂文件 | 作用 |
|---|---|
| `xxx.png`、`xxx.preview.png` | 封面缩略图 |
| `xxx.txt`、`xxx.safetensors.txt` | 说明文本；含「触发词：」的段落会被解析成可点击段落 |
| `xxx.metadata.json` | 结构化信息：`trainedWords`（触发词首选来源）、`base_model`、`tags`、`model_name` |

### 一键从 Civitai 补

1. 打开「懒人的 CLIP 文本编码」的 **LoRA** 页
2. **右键某个 LoRA** → 「补封面与说明（Civitai）」
   插件算出文件 SHA256 的前 10 位，用它查 Civitai 的版本，然后写三样东西：
   - `xxx.png` —— 第一张非 NSFW 图（宽 512）
   - `xxx.txt` —— 触发词段 + 模型说明
   - `xxx.metadata.json` —— `trainedWords`、`base_model`、Civitai 链接
3. **右键分组标题** → 「补全本组缺失（最多 8 个）」，一次补一批（每个之间停 1 秒）

已经存在的图或 txt **不会被覆盖**，只在缺的时候写。

### 几个前提

- 要能访问 `civitai.com`。默认走 `127.0.0.1:7890` 代理，改法：`config.json` 里加 `"civitai_proxy": "http://127.0.0.1:7891"`，写空串则直连
- 查不到通常是因为文件被自己合并/重打包过（哈希变了），或作者没发到 Civitai
- 第一次给大文件算哈希要读完整文件（1 GB 约十几秒），结果缓存在 `civitai_hashes.json`，之后秒回
- 也能手动补：图存成 `xxx.png`，说明存成 `xxx.txt`，格式：
  ```
  触发词：
  word1, word2

  否定提示词（Negative）：
  low quality, bad hands
  ```

## 目录配置

`config.json`：

```json
{
  "lora_roots": ["D:/path/to/sd-webui-forge/models/Lora"],
  "default_strength": 0.8,
  "scan_ttl": 30,
  "auto_trigger": true
}
```

- `lora_roots`：额外 LoRA 根目录，`ComfyUI/models/loras` 始终会被扫描。
- `scan_ttl`：目录扫描缓存秒数，新下的 LoRA 用节点右键「刷新 LoRA 目录」或弹窗「重新扫描目录」立刻生效。
- `auto_trigger`：添加 LoRA 时自动带入识别到的触发词（你在 `triggers.json` 里存过的词优先级更高）。

## 触发词文件

`triggers.json`（插件目录，自动创建）：

```json
{
  "anima/AA画风/real_skin.safetensors": "@m4tte",
  "anima/eudie_v1.safetensors": "Shadowverse Eudie, metal hair ornament",
  "anima/AA画风/@ix7.safetensors": ""
}
```

- 键＝LoRA 相对路径（与编排器行里存的一致），值＝触发词；空串表示"明确不要触发词"。
- 后端接口：`GET /shiyi_lora/triggers`，`POST /shiyi_lora/triggers`（`{name, words}` 或 `{triggers: {...}}`）。

## 说明段落怎么切

内联展开的段落由 `.txt` 自动解析：**以 `：`/`:` 结尾的短行当标题**，其后连续的标签行合成一段；段落必须像标签（含逗号 + 英文词）。叙述型 txt（如 `real_skin`）解析不出段落，页面只显示原文。后端接口带 `sections` 字段；后端没更新时前端会用同一套规则自己解析，效果一致。

想自己定段落，就在 txt 旁边放一个同名 `*.sections.json`（优先级高于自动解析）：

```json
[
  { "title": "全身", "text": "xxx, 1girl, solo, full body, ..." },
  { "title": "不要的", "text": "chibi, text, logo", "negative": true }
]
```


## HTTP 接口（前端用，也可自己 curl）

- `GET /shiyi_lora/list[?refresh=1]` — 全部 LoRA（名字/目录/是否有预览与说明）
- `GET /shiyi_lora/info?name=anima/eudie_v1.safetensors` — 单个 LoRA 的说明、触发词、标签
- `GET /shiyi_lora/preview?name=…` — 预览图

## 与旧工作流的对接

`anima008.json` 里的 LoRA 行名（`anima\AA画风\real_skin.safetensors`）可以直接用，反斜杠会被归一化。找不到的文件会在控制台打 `LoRA not found, skipped: …` 并跳过，不会中断整次生成。

## 调试

浏览器控制台：`window.__shiyiLora`（`rowsOf` / `commit` / `openPicker` / `getInfo`）。






