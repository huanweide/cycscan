<!-- badges -->
[![License](https://img.shields.io/github/license/huanweide/cycscan)](LICENSE)
[![Stars](https://img.shields.io/github/stars/huanweide/cycscan)](https://github.com/huanweide/cycscan/stargazers)
[![Engineering Health Family](https://img.shields.io/badge/Engineering%20Health%20Family-18%20axes-22c55e)](https://github.com/huanweide/family-showcase)
<!-- /badges -->

**🔧 Part of the [Engineering Health Family](https://github.com/huanweide/family-showcase)** (18 zero-dependency checkup axes). Standalone tool — see [doctors](https://github.com/huanweide/doctors) (monorepo) and [enghealth](https://github.com/huanweide/enghealth) (unified runner).

# cycscan

> 零依赖单文件 Node CLI · 结构复杂度静态扫描器

扫描 JS / TS / JSX / TSX / Vue / Svelte 源码，找出两类最高频的「结构坏味道」，**零配置、离线、单文件、跨平台**，直接进 pre-commit / CI。

## 安装

本项目**尚未发布到 npm**（`npm view cycscan` 返回 404），所以 `npx cycscan` 目前是条死命令。请从源码用：

```bash
git clone https://github.com/huanweide/cycscan.git
node cycscan/index.js --root ./src --max-complexity 20 --fail-on-high
```

或把 `index.js` 复制进你自己的仓库（只依赖 Node 内置模块，无需 `npm install`）。

## 为什么需要它

圈复杂度（cyclomatic complexity）和超长函数，是 SonarQube 等主流工具最核心的**代码健康指标**。但：

- `oxlint` 需要 Rust 工具链；`ESLint` + `typescript-eslint` 需要一堆配置。
- `escomplex` / `complexity-report` 都停在 `2.0.0-alpha`，且需要 `npm install` 拉 AST 解析链。
- **cycscan 纯文本层零依赖单文件**确定性静态扫描，开箱即跑，无需任何配置，能在任何 CI 上 30 秒内出结果。

## 检测规则

| 规则 | 严重度 | 默认阈值 | 信号 |
| --- | --- | --- | --- |
| `complex-function` 圈复杂度过高 | high | 复杂度 > `10` | 意大利面条函数，分支爆炸 |
| `long-function` 函数过长 | medium | 长度 > `60` 行 | 上帝函数，可读性差 |

圈复杂度算法（McCabe 近似）：基础 1 + 分支决策点（`if` / `for` / `while` / `do` / `switch` / `catch` / `case` / `&&` / `||` / `?`）。**嵌套函数内层块不计入外层**，避免爷爷函数被孙子分支虚高。

## 用法

```
cycscan [scan] [--root <dir>] [--json]
        [--complexity-threshold <n>] [--lines-threshold <n>]
        [--max-high <n>] [--max-medium <n>] [--max-issues <n>]
        [--max-complexity <n>] [--max-lines <n>]
        [--fail-on-high] [--fail-on-issues]
```

**检测阈值**（调扫描灵敏度，`>= 1` 的整数）：

- `--complexity-threshold <n>`：圈复杂度报警阈值（默认 `10`）
- `--lines-threshold <n>`：函数长度报警阈值（默认 `60` 行）

**门禁阈值**（`>= 0` 的整数，`0` 是合法值 = 禁止任何一项）：

- `--max-high / --max-medium / --max-issues <n>`：对应问题数超过则门禁失败
- `--max-complexity <n>`：最高圈复杂度超过则失败（CI 最常用）
- `--max-lines <n>`：最长函数超过则失败
- `--fail-on-high`：出现任何圈复杂度过高即失败
- `--fail-on-issues`：存在任何警告即失败
- `--json`：机器可读输出

### 退出码契约

| 退出码 | 状态 | 含义 |
| --- | --- | --- |
| `0` | `pass` | 已配置门禁阈值，且全部达标 |
| `2` | `fail` | 已配置门禁阈值且存在不达标项；**或**参数非法 |
| `3` | `inconclusive` | **未配置任何门禁阈值，或扫描输入为空 —— 结论不可信，不等于通过** |
| `1` | 内部异常 | 仅用于未预期异常，门禁本身不返回 1 |

> **为什么要有 `3`**：扫描型门禁最恶劣的失败模式是「扫了 0 个文件却报通过」——CI 上成一片永不熄灭的绿灯。
> 判定顺序固定为：① 配了阈值吗 → ② 输入可信吗 → ③ 有不达标项吗。空输入下 `--fail-on-issues`
> 也返回 `3`，因为那条「警告」本身就是空扫描的产物，不足为凭。
>
> **参数写错 = 门禁不存在**：阈值缺值 / 空串 / 尾随垃圾（`5abc`）/ 小数 / 负数 / 十六进制 / `Infinity`；
> `--root` 缺值或吞掉下一个标志；任何未知选项（含 `-x`、拼错的 `--max-issue`）—— 一律 `exit 2`，绝不静默放行。
>
> 特别提醒 `--complexity-threshold`：它一旦变成 `NaN`，`复杂度 > NaN` 恒为 false，
> **整个检测会静默失效、一个问题都报不出来、退出码还是 0**。所以参数校验是 P0，不是锦上添花。

### JSON 输出

顶层含 `basisComplete`（布尔）。`false` 表示扫描输入不可信，此时 `healthScore` 为 `null` —— 请勿把它当 0 或 100 用。
`gate` 是对象 `{ state, configured, reason, failures }`，不是布尔。

## CI 集成

```yaml
# .github/workflows/quality.yml
- name: 结构复杂度门禁
  run: node .github/cycscan/index.js --root src --max-complexity 20 --max-lines 100 --fail-on-high
```

> 若 clone 本仓库到 CI，请写明确的 `node <路径>/index.js`，不要用 `npx cycscan`（npm 上没有这个包）。
>
> CI 里请**显式传一个门禁阈值**。不传任何阈值时退出码是 `3`（未决），会直接把流水线判红 ——
> 这是刻意的：门禁必须由使用方明确定义，工具不该替你猜。

```bash
# 本地 pre-commit
node cycscan/index.js --root . --max-complexity 20 && echo "复杂度 OK"
```

## 健康分

每千行源码允许 `1` 个加权问题不扣分，超出按系数 `25` 扣，得分 `0–100`：

- `90+` 健康
- `70–89` 基本健康
- `40–69` 结构风险偏高
- `<40` 结构风险高

扫描输入为空时健康分为 `null`（`verdict: 无法评估`），**不会给出 100 分误导你**。

## 示例输出

```
cycscan · 结构复杂度扫描 · root=/project/src
  扫描源文件   : 42
  函数总数     : 318
  源码总行数   : 8742
  问题总数     : 5 (加权 11)
  最高圈复杂度 : 27
  最长函数     : 153 行
  健康分       : 72 / 100  [基本健康]
  门禁: 通过  [state=pass configured=true]
    理由: 全部已配置门禁项达标。
```

## 与同家族工具

cycscan 是「代码健康 family」第六轴（结构复杂度），与以下零依赖单文件工具互补：

- `devdoctor` —— 依赖体检（胖瘦 / 许可证 / 循环依赖 / 密钥）
- `testlite` —— 测试卫生体检
- `debtlens` —— 技术债密度（TODO/FIXME 等）
- `a11ydoctor` —— Web 可访问性静态扫描
- `awaitscan` —— 异步性能反模式（串行 await / 嵌套循环）

## 设计铁律

- 纯本地、零依赖、离线、单文件，跨平台（Windows posix 路径）。
- 逐字符 tokenizer 剥离注释/字符串（保留换行）—— 防示例/文档伪信号，避免 dogfood 自我污染。
- 括号平衡定位函数体 + 嵌套函数排除（「表层」哲学）。
- `node_modules` / `dist` / `build` 等目录自动跳过；单文件 > 5MB 跳过防 OOM。
- **门禁三态，不谎报绿灯**：未配阈值或输入为空一律返回 `3` 并打印 `state=inconclusive`，绝不沉默。
- **健康分是有害指标**：扫不到东西时给 `null`，不给 100 分。
- **门禁失败消息必须回显真实阈值**——打印 `undefined` 等于没说。

## 开发与测试

零依赖，`node` 直接跑，无需 `npm install`：

```bash
node test/unit.test.js     # 单元测试：扫描逻辑 / 三态判定 / 参数解析 / 自检门禁
node test/smoke-cli.js     # spawn 级冒烟：真起进程钉死退出码契约
npm test                   # 等价于依次跑上面两个
```

两层测试的分工是刻意的：单测只覆盖导出的纯函数，**完全不碰 `process.exitCode`**；退出码契约只能由 `smoke-cli.js` 用 `spawnSync` 真起进程来验。改退出码时单测可能依然全绿，只有冒烟能拦住。

## License

MIT

---

## 作者

由 **ReTr · 樊斯瑞** 维护 · [GitHub 主页](https://github.com/huanweide)

## 赞助支持

如果这个项目帮到了你，欢迎 [点 Star](https://github.com/huanweide/cycscan) 支持；也可微信扫码自愿赞助（收款码见 `sponsor/wechat-qr.png`，作者本人带 Tri 水印的码，纯静态图片、不含任何密钥）。

## 许可证

MIT，详见 [LICENSE](LICENSE)。
---

## 便携性 · 零依赖承诺

- 零运行时依赖：只用一个 Node 内置模块，无需 `npm install`。
- 单文件：整个工具就是一个 `index.js`，复制进任何仓库即可用。
- 离线 / 跨平台：Node 18+ 即可，不联网、不挑系统。
- 一键跑：`node index.js --root ./src`（详见上方用法）。

← [回到代码健康家族总览](https://github.com/huanweide/family-showcase)
