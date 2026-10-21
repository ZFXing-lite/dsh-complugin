# 模块契约 / Module contract

这份文档写给「以后要往 `dsh-complugin` 里加功能」的人（包括几个月后的你自己）。
一页读完，照着做就不会破坏面板、不会破坏设置迁移、不会和宿主打架。

This is the contract for adding a feature to `dsh-complugin`. Read it once, follow
it, and the panel, the settings migration and the host stay intact.

---

## 1. 一个功能 = 一个模块文件 / One feature = one module file

```
lib/modules/my-feature.js     ← 你写的（唯一的业务代码）
lib/modules/index.js          ← 加一行 import + 加进数组（唯一的注册处）
```

面板、HTTP、设置、日志、迁移、补丁管理全部由宿主负责，**你不需要改**：
`lib/index.js`、`lib/core/*`、`lib/client.js` 都不要动。

The panel, HTTP routes, settings, logging, migration and patch handling are all
host responsibilities. You do not touch `lib/index.js`, `lib/core/*` or
`lib/client.js`.

```js
// lib/modules/my-feature.js
import { defineModule } from "../core/registry.js";

export default defineModule({
	id: "myFeature",        // 小驼峰，全局唯一，就是设置里的键名
	kind: "hook",           // hook = 只挂事件；patch = 主要靠改宿主源码
	order: 50,              // 面板排序（小的在上）
	title: "我的功能",
	summary: "一句话说清用户能得到什么。",
	legacy: "my-feature",   // 老命名空间（没有就留空字符串），用于一次性继承配置
	docs: "展开卡片底部的小字说明。",
	fields: [ /* 见第 2 节 */ ],
	actions: [ /* 见第 3 节 */ ],
	patch: undefined,       // 可选，见第 4 节
	mount({ ctx, env, logger, config }) {
		// 挂载逻辑。返回 { status?, actions?, dispose? }，全部可选。
	}
});
```

`defineModule` 会校验并冻结：`id` 必须是合法标识符、`title` 必填、`fields[].key`
不能重复、`actions[].id` 不能重复、`mount` 必须是函数。校验不过就在加载时抛错，
宿主会把这条模块标成「挂载失败」而不是整机崩掉。

Validation happens at load time. A bad module becomes a red card, never a crash.

---

## 2. 字段 / Fields

字段是**唯一**的配置来源：设置 schema 由字段生成，面板由字段渲染，迁移也认字段。

```js
fields: [
	{ key: "enabled", label: "启用", type: "switch", group: "basic", default: true,
	  hint: "面板上显示在输入框下面的那行小字。" },

	{ key: "delayMs", label: "延迟", type: "number", group: "tuning",
	  default: 1500, min: 200, max: 60000, step: 100, unit: "ms",
	  hint: "越界会被夹到 min/max，不会被拒绝。" },

	{ key: "prompt", label: "提示词", type: "textarea", group: "basic",
	  default: "", rows: 3, maxLength: 4000, placeholder: "留空用内置提示词" },

	{ key: "mode", label: "模式", type: "select", group: "basic", default: "auto",
	  options: [
		{ value: "auto", label: "自动", hint: "需要时才介入" },
		{ value: "off",  label: "关闭", hint: "完全不动" }
	  ] },

	{ key: "levels", label: "档位", type: "multi", group: "tuning",
	  default: ["low", "medium", "high"],
	  options: [{ value: "low", label: "Low" }, { value: "medium", label: "Medium" }] },

	{ key: "apiKey", label: "密钥", type: "secret", group: "advanced",
	  default: "", hint: "面板不回显；只显示「已保存」。" }
]
```

| type | 面板控件 | 说明 |
|------|----------|------|
| `switch` | 开关 | `true` / `false` |
| `number` | 数字框 | 自动夹取到 `min`/`max`，按 `step` 对齐；`unit` 显示在右侧 |
| `text` | 单行输入 | |
| `secret` | 密码框 | 状态里只带 `present: true/false`，值永不出网 |
| `textarea` | 多行 | `rows` 控制高度 |
| `multi` | 药丸多选 | 数组，非法选项会被丢弃 |
| `select` | 下拉 | 未知值回落到默认值 |

`group` 只有三个，决定折叠抽屉的归属，顺序固定 **基础 → 调参 → 高级**：

- `basic` 日常开关（默认展开）
- `tuning` 行为细节（默认展开）
- `advanced` 危险区（默认收起，需要用户自己点开）

规则：默认值必须是「安全的」。用户从不动面板时，插件必须是对的。

---

## 3. 动作 / Actions

动作是面板上的按钮，两种形态：

```js
actions: [
	// A. 走统一调度：POST /api/complugin/action { module, action, values }
	{ id: "reset", label: "重置计数", desc: "把统计清零", tone: "ghost" },

	// B. 自己带路由：POST <route> { action, values }
	//    适合返回非标准结构（比如列表、外带数据）的动作
	{ id: "models", label: "拉取模型", route: "/api/complugin/vision/models" },

	// C. needs：这些字段为空时按钮自动置灰
	{ id: "saveKey", label: "保存密钥", needs: ["apiKey"] }
]
```

A 型动作在 `mount()` 的返回值里实现：

```js
return {
	actions: {
		async reset() { count = 0; return { ok: true, detail: "已清零" }; }
	}
};
```

`result.detail` 会作为绿色提示直接显示在卡片里；`{ ok: false, detail }` 显示成红色。

---

## 4. 宿主补丁 / Host patches

有些功能必须改 DSH 自己的源码（例如给私有函数加默认值）。不要发 shell 脚本，
声明一个补丁描述符，面板会给出「应用 / 回滚 / 重新检测」三个按钮：

```js
import { definePatch } from "../core/hostpatch.js";

const FILE_PATCH = definePatch({
	id: "my-patch",                       // 补丁 id，备份目录按它分文件夹
	label: "我的补丁（文件补丁）",
	package: "@deepseek-ai/dsh-some-pkg", // 目标包名（走 node_modules 解析）
	file: "lib/index.js",                 // 包内相对路径
	find: "\tif (x === void 0) return { a: 1 };",   // 必须**恰好出现一次**
	replace: "\tif (x === void 0) {\n\t\treturn { a: 2 };\n\t}",
	marker: "return { a: 2 }",            // 幂等标记：出现即视为已应用
	note: "升级 DSH 后需要重打。"          // 面板上的一句话说明
});

export default defineModule({ /* … */ patch: FILE_PATCH });
```

宿主行为（`lib/core/hostpatch.js`）：

- **锚点必须唯一**。出现 0 次 → `missing`（版本变了）；出现 2 次以上 → `conflict`，
  两种都不会动文件。
- **写前先备份**：`~/.dsh/complugin/backups/<id>/<时间戳>__<文件名>`，保留最近 5 份。
- **重复应用是幂等的**：`marker` 已存在就直接返回成功。
- **回滚**还原备份内容，不依赖 `find` 还匹配得上。

**首选运行时接管，其次才是文件补丁。** 如果目标的取值路径经过某个原型方法，
包装那个方法比改文件更稳：不用磁盘写权限、升级 DSH 不丢、卸载即还原。
`lib/modules/reasoning-effort.js` 是两种做法的对照示例。

---

## 5. `mount()` 的入参 / What mount() receives

```js
mount({ ctx, env, logger, config }) {
	// ctx     —— 伪装成 cordis ctx 的代理。logger / settings / inject / effect 都通，
	//             其中 settings.register() 返回的是**本模块自己那段配置**的作用域，
	//             所以老的 apply(ctx, config) 逻辑可以整段搬过来，一行不改。
	// env     —— { home, patch, store(name, opts), module(id), onChange(cb), config() }
	// logger  —— 自动加 `complugin: ` 前缀，并进环形日志（面板能看到）
	// config  —— 你现在这段配置的只读快照：() => ({ ...fields })
}
```

返回值（全部可选）：

```js
return {
	status: () => ({
		ready: true,            // 决定左侧状态条和「就绪」计数
		sign: "on",             // on | warn | error | off | idle
		badge: "运行中",         // 卡片右上角的小标签
		line: "阈值 0.8 / 0.85", // 展开后的第一行状态
		stats: [{ label: "压缩", value: 2 }],
		entries: [{ level: "info", text: "…" }]   // 面板上的小日志
	}),
	actions: { /* 见第 3 节 */ },
	dispose: () => { /* 卸载清理；用 ctx.effect 也行 */ }
};
```

`status()` 会被面板每 3 秒调一次，**必须廉价**：读内存，不要发网络请求。

---

## 6. 设置与迁移 / Settings and migration

- 全插件只有一个命名空间：`complugin`，形如
  `{ enabled: true, modules: { myFeature: { … } } }`。
- 每个字段的类型/范围/默认值都由字段自己声明，所以**加模块不需要改 schema**，
  删模块也不会让读取炸掉（未知键被 `normalizeConfig` 丢掉）。
- `legacy: "my-feature"` 会让宿主在第一次启动时从旧命名空间**只补缺失键**地继承一次
  （`~/.dsh/settings.yaml` 里的 `my-feature:` 块），继承完在
  `~/.dsh/complugin/state.json` 里打标记，永不覆盖用户后来改过的值。

---

## 7. 自检清单 / Checklist

新增模块后，跑这三条：

```bash
node --test                                        # 全量测试
node --input-type=module -e "import('./lib/modules/index.js').then(m=>console.log(m.default.map(x=>x.id)))"
dsh --profile web --dump-config >/dev/null && echo "配置组合通过"
```

面板侧不需要任何改动 —— 新模块会自动出现在「DSH功能补全插件」的列表里。
如果它没出现，问题一定在 `lib/modules/index.js` 的数组里，不在前端。
