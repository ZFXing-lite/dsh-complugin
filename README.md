# dsh-complugin —— DSH 功能补全插件

给 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai) 用的**一个**插件，
把常用的几件「小功能」收进同一个面板里：自动压缩、自动继续、视觉桥、推理等级。
装完在 **设置 → 插件 → 功能补全** 里就是一个独立页签（和「插件配置」「插件列表」同级），
全部开关、阈值、密钥都在那儿改，保存即生效；面板右上角还能直接检查并拉取本仓库的更新。

> 一个插件 = 一个设置命名空间 = 一个面板。以后加功能，只加一个模块文件。

---

## 它做什么 / Features

| 模块 | 解决的问题 | 默认 |
|------|-----------|------|
| **自动压缩** | 上下文快满时自动调用官方压缩引擎，会话不断、活继续干。阈值可调，支持准备态提示。 | 开 |
| **自动继续** | 一回合结束时如果模型是被截断/出错的，按设定策略自动再推一轮（可选自定义提示词、连击上限、`/continue` 之外的边界控制）。 | 关 |
| **视觉桥** | 纯文本模型也能「看图」：把图片附件交给任意 OpenAI 兼容的视觉端点转述成文字，再塞回对话，附来源与尺寸标注。带本地缓存。 | 开（需配置） |
| **推理等级** | 手写声明的模型在菜单里没有「推理等级」时，补上 low / medium / high 三档可选，请求侧同步生效。 | 开 |

四个模块彼此的配置互不干扰，但共享同一个总开关、同一套日志、同一种「恢复默认」。

面板顶部还有 **检查更新 / 更新到 xxxx**：直接比对本地 HEAD 和仓库 `main`，
落后就 `git pull --ff-only` 拉下去，拉完提示重启 DSH。

---

## 安装 / Install

```bash
# 放进 DSH 的插件目录（或任意被 profile 引用的位置）
git clone https://github.com/ZFXing-lite/dsh-complugin.git
```

然后在 DSH 的 profile（例如 `~/.dsh/profiles/web/package.json`）里把它加进
`dependencies` 与 `dsh.profile.bundles`：

```json
{
  "dependencies": { "dsh-complugin": "file:./dsh-complugin" },
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "dsh-complugin"
  ] } }
}
```

重启 `dsh web`，打开 **设置 → 插件 → 功能补全**，看到面板即可（它和「插件配置」「插件列表」是同级页签）。

> 浏览器那一半（`lib/client.js`）需要重启一次 `dsh web` 才会被重新打包进前端。

卸载 = 从 `bundles` 里删掉这一行；插件不写任何全局状态，删掉即回到原生行为。

---

## 面板 / The panel

位置：**设置 → 插件 → 功能补全**（第三个页签，自己一屏，不跟别的插件抢位置）。

```
┌ 功能补全  v1.1.0   [检查更新]  [刷新]  [总开关]                 ┐
│ 3/4 个模块就绪 · 无异常 · 1 个宿主补丁 · 已是最新 7c3bf7b        │
├─────────────────────────────────────────────────────────────────┤
│ ▍自动压缩            监控中           [保存] [丢弃]              │
│ ▍自动继续            已开启                                      │
│ ▍视觉桥              未就绪          缺项：apiKey                │
│ ▍推理等级            接管中          含补丁                      │
└─────────────────────────────────────────────────────────────────┘
```

- 每张模块卡片点标题展开/收起，左侧竖条就是状态灯（绿=就绪、黄=需注意、红=异常）。
- 卡片内字段按 **基础 / 调参 / 高级** 三段折叠，高级默认收起。
- 点开关本身、或点左边的字段名，都能切；数字/文本框直接输入，回车或失焦即暂存。
- 改动的字段会标「改动未保存」，可以单字段恢复默认，也可以整段丢弃。
- 需要宿主源码配合的功能会多一个虚线框「补丁」区：应用 / 回滚 / 重新检测。
- 右上角 **检查更新** 比对仓库 `main`，落后就变成 **更新到 xxxx**，点一下拉完并提示重启。
- 面板只认 `/api/complugin/status` 返回的结构，**新模块不需要改前端**。

---

## 扩展 / Extending

加一个功能就三步：

1. 写 `lib/modules/your-feature.js`，`export default defineModule({ id, title, fields, actions, mount })`。
2. 在 `lib/modules/index.js` 里 import 并加入数组。
3. `npm test`。

字段类型、动作路由、补丁描述符、`mount()` 的入参与返回值，全在
[`docs/MODULE-CONTRACT.md`](docs/MODULE-CONTRACT.md) 里写清楚了，一页读完。

---

## 兼容性与注意 / Notes

- 目标运行时：DSH `0.1.5-rc.2`（`@deepseek-ai/*` 系列）。
- 「推理等级」默认走**运行时接管**（包装适配器的取值方法），不写磁盘、升级 DSH 不丢；
  卡片里的「文件补丁」是等价的老办法，升级会被覆盖，留作可选与回滚点。
- 设置只有 `complugin` 一个命名空间；如果你之前单独装过上面某个小插件，
  首次启动会**只补缺失项**地把旧配置继承过来，不覆盖你后来改过的值。
- 视觉桥的密钥优先读环境变量 `VISION_BRIDGE_API_KEY`，其次才用面板里保存的那份；
  面板永不回显密钥，只显示「已保存」。

---

## 开发 / Development

```bash
node --test          # 50 个测试：注册表、字段、补丁、迁移、面板 API、视觉桥、决策引擎、更新器、前端渲染

# 用无头 Chrome 驱动真实前端：开设置 → 插件 → 功能补全，点开关、点字段名、看保存按钮醒没醒
node scripts/check-panel.mjs "http://127.0.0.1:3080/?token=TOKEN"
```

仓库结构：

```
lib/
  index.js              宿主入口：设置注册 + 模块挂载 + HTTP + 生命周期
  client.js             浏览器入口：通用面板（不认识任何具体功能）
  core/                 框架层：字段、注册表、存储、迁移、补丁、路由、纯函数
  modules/              功能层：每个文件一个功能
docs/MODULE-CONTRACT.md 模块契约
scripts/                开发辅助：无头浏览器冒烟
test/                   测试
```

---

## License

MIT

---

# dsh-complugin — All-in-one feature pack for DSH

One DSH plugin that bundles the small quality-of-life features most people end up
installing separately: **auto-compact**, **auto-continue**, **vision bridge** and
**reasoning-effort defaults**. Everything lives in its own tab: Settings → Plugins →
**功能补全**, next to "插件配置" and "插件列表".

**What it gives you**

- *Auto-compact* — compacts the session through the official engine when context
  pressure crosses your thresholds, so a long task never dies mid-flight.
- *Auto-continue* — when a turn ends truncated or errored, pushes one more round
  under rules you set (custom prompt, streak cap, subagent scope).
- *Vision bridge* — lets a text-only route "see": images are transcribed by any
  OpenAI-compatible vision endpoint and re-injected as labelled text, with a
  local cache.
- *Reasoning effort* — models declared by hand get the low/medium/high selector
  they were missing, on both the menu and the request path.
- *Self-update* — the panel compares your checkout with `origin/main` and fast-forwards
  in place; the header tells you which commit you are on.

**Install**: add `dsh-complugin` to your profile's `dsh.profile.bundles`, restart
`dsh web`, open Settings → Plugins → 功能补全.

**Extend**: drop a `defineModule({...})` file into `lib/modules/`, add one line to
`lib/modules/index.js`. The panel, the settings namespace, logging, migration and
patch handling are generic — see `docs/MODULE-CONTRACT.md`.

**Tests**: `node --test` (50 tests, no network, no browser). The browser check drives
the real UI over CDP — it opens the tab and clicks a switch, which is what catches an
inert panel: `node scripts/check-panel.mjs <web-url-with-token>`.

MIT.
