# cycscan

> 零依赖单文件 Node CLI · 结构复杂度静态扫描器

扫描 JS / TS / JSX / TSX / Vue / Svelte 源码，找出两类最高频的「结构坏味道」，**零配置、离线、单文件、跨平台**，直接进 pre-commit / CI。

```bash
npx cycscan --root ./src --fail-on-high
```

## 为什么需要它

圈复杂度（cyclomatic complexity）和超长函数，是 SonarQube 等主流工具最核心的**代码健康指标**。但：

- `oxlint` 需要 Rust 工具链；`ESLint` + `typescript-eslint` 需要一堆配置。
- **cycscan 纯文本层零依赖单文件**确定性静态扫描，开箱即跑，无需任何配置，能在任何 CI 上 30 秒内出结果。

## 检测规则

| 规则 | 严重度 | 默认阈值 | 信号 |
| --- | --- | --- | --- |
| `C1 complex-function` 圈复杂度过高 | high | 复杂度 > `10` | 意大利面条函数，分支爆炸 |
| `C2 long-function` 函数过长 | medium | 长度 > `60` 行 | 上帝函数，可读性差 |

圈复杂度算法（McCabe 近似）：基础 1 + 分支决策点（`if` / `for` / `while` / `do` / `switch` / `catch` / `case` / `&&` / `||` / `?`）。**嵌套函数内层块不计入外层**，避免爷爷函数被孙子分支虚高。

## 用法

```
cycscan [scan] [--root <dir>] [--json]
        [--complexity-threshold <n>] [--lines-threshold <n>]
        [--max-high <n>] [--max-medium <n>] [--max-issues <n>]
        [--max-complexity <n>] [--max-lines <n>]
        [--fail-on-high] [--fail-on-issues]
```

- `--complexity-threshold <n>`：圈复杂度报警阈值（默认 `10`）
- `--lines-threshold <n>`：函数长度报警阈值（默认 `60` 行）
- `--max-high / --max-medium / --max-issues <n>`：对应问题数超过则门禁失败
- `--max-complexity <n>`：最高圈复杂度超过则失败（CI 最常用）
- `--max-lines <n>`：最长函数超过则失败
- `--fail-on-high`：出现任何圈复杂度过高即失败
- `--fail-on-issues`：存在任何警告即失败
- `--json`：机器可读输出

> 所有阈值参数均做 `Number.isFinite` 校验，非整数直接 `exit 2`，绝不静默放行。

## CI 集成

```yaml
# .github/workflows/quality.yml
- name: 结构复杂度门禁
  run: npx cycscan --root src --max-complexity 20 --max-lines 100 --fail-on-high
```

```bash
# 本地 pre-commit
cycscan --root . --fail-on-high && echo "复杂度 OK"
```

退出码：`0` 通过，`2` 门禁失败，`1` 运行异常。

## 健康分

每千行源码允许 `1` 个加权问题不扣分，超出按系数 `25` 扣，得分 `0–100`：

- `90+` 健康
- `70–89` 基本健康
- `40–69` 结构风险偏高
- `<40` 结构风险高

## 示例输出

```
cycscan · 结构复杂度扫描 · root=/project/src
  扫描源文件   : 42
  函数总数     : 318
  源码总行数   : 8742
  最高圈复杂度 : 27
  最长函数     : 153 行
  健康分       : 72 / 100  [基本健康]
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

## License

MIT

---

## 作者

由 **ReTr · 樊斯瑞** 维护 · [GitHub 主页](https://github.com/huanweide)

## CI 门禁用法

开箱即可接入 CI：在流水线中运行本工具，它会输出健康分与严重度；若存在不达标项会以非 0 退出码结束，从而拦下问题提交（具体参数见上方「快速开始」）。

## 赞助支持

如果这个项目帮到了你，欢迎 [点 Star](https://github.com/huanweide/cycscan) 支持；也可微信扫码自愿赞助（收款码见 `sponsor/wechat-qr.png`，作者本人带 Tri 水印的码，纯静态图片、不含任何密钥）。

## 许可证

详见 [LICENSE](LICENSE)。
