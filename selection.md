# cycscan · 选题终裁（Overlord 单项目深耕 · 2026-08-14）

## 背景
awaitscan 已上架成熟（family 第五轴：异步性能反模式）。`next_action: select`，本轮重新选题。
候选池落选萃取现状：
- nono（沙箱）/ Book-to-Skill（PDF管道）/ formlite（Web表单）/ Jay（TUI导航）/ SkillForge（skill治理）——全部偏离零依赖单文件基线，且 Jay/SkillForge 有上游收编风险。
- perfscan → 已复活为 awaitscan（第六轴候选被占用）。

依 core-memory 第 140/142 条裁定「零依赖切口枯竭 → 转质量深化 / 家族叙事」。

## 三维硬标准过检（马斯克终裁）
1. **受众（大）**：任何 JS/TS/Vue/Svelte 项目都有「圈复杂度爆表 / 超长函数」两类结构坏味道，是 SonarQube 等主流工具最核心的代码健康指标，普适性极强。
2. **实用性（高）**：零依赖开箱即扫两类坏味道 + 严重度加权 + 0–100 健康分 + CI 门禁（--max-complexity / --max-lines / --fail-on-high），可直接进 pre-commit / CI。
3. **差异化（更好）**：oxlint 需 Rust 工具链、ESLint+typescript-eslint 需配置；我们纯文本层零依赖单文件确定性静态扫描，圈复杂度算法（分支计数 + 嵌套函数排除）可复现、无配置、跨平台。

## 决策
选定 **cycscan** —— 零依赖单文件 Node CLI，扫 JS/TS 生态的：
- **C1 complex-function（high）**：圈复杂度 > 阈值（默认 10），经典"意大利面条函数"信号。
- **C2 long-function（medium）**：函数长度 > 阈值（默认 60 行），"上帝函数"信号。

补 family 第六轴「结构复杂度」，与 devdoctor(依赖)/testlite(测试)/debtlens(债务)/a11ydoctor(a11y)/awaitscan(异步性能) 拼成代码健康 family 六件套。

## 方法继承（family 沉淀复用）
- 逐字符 tokenizer 剥离注释/字符串（保留换行）—— 来自 awaitscan 方法沉淀，解决 dogfood 自我污染。
- 括号平衡定位函数体 + 排除嵌套函数内层块（"表层"哲学）—— 来自 awaitscan。
- CLI 门禁阈值一律 `Number.isFinite` 校验（非整数 exit 2）—— 来自 chaineye 方法沉淀。
- 5MB 大文件跳过防 OOM、root statSync 先验目录 —— family 标配。
