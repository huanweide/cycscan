# cycscan · 魔王轮转评审记录（Overlord 主代理亲做六视角）

> 本环境 Agent 派发不可靠，按铁律第 9 条由主代理亲自执行六视角评审 + 代码。

## 六视角评审（降级为命令链路 + 边界验证，CLI 无 GUI 故 UI·a11y N/A）

| 视角 | 关注点 | 结论 |
| --- | --- | --- |
| 资深/架构 | 函数边界检测是否稳健、圈复杂度算法是否正确 | 括号平衡 + 嵌套函数排除正确；实测嵌套函数不虚高外层 |
| 安全 | 是否联网/执行/读敏感 | 纯本地只读 fs 扫描，无网络、无 exec、无密钥，**安全** |
| 小白/易用 | CLI 是否直觉、文档是否够 | `--help` 全参数说明；README 含 CI 集成示例；**易用** |
| 性能 | 大仓库耗时 | forge 30 文件/8346 行 ≈ 11ms；5MB 跳过防 OOM，**性能达标** |
| 可维护 | 自身代码复杂度 | 初版 4 函数自报 >10 复杂度 → 重构归零（见下） |
| a11y | N/A（CLI 无界面） | 跳过 |

## 收敛红点（主代理亲做，一轮归零）

### 红点 1：`--root` 值被 parseInt 当成整数（致命 bug）
- 现象：运行即 `path.resolve(NaN)` 抛错 exit 1。
- 根因：`parseArgs` 把 `--root` 与数值阈值混用同一 `parseInt` 分支。
- 修复：拆出 `STR_FLAGS`（路径）与 `NUM_FLAGS`（数值），`--root` 直接存字符串。

### 红点 2-5：工具自身 4 函数自报「圈复杂度过高」（dogfood 未归零）
- 现象：dogfood 扫描自身报 4 处 high（stripNoise=21 / findFunctionKeyword=12 / findArrows=14 / printReport=13），健康分 0。
- 根因：这些函数分支密集（`while+&&` 名字跳过、`||` 链、大段 if 打印）。
- 修复（以身作则，拆小至 <10）：
  - `stripNoise` → 抽出 `skipLineComment` / `skipBlockComment` / `skipString` / `fillSpaces` 四个助手，主函数仅分发。
  - `findFunctionKeyword` → 名字跳过改正则 `/^[A-Za-z0-9_$]*/`，去掉 `while+&&`。
  - `findArrows` → 抽出 `findParamOpen` 反向括号匹配助手。
  - `printReport` → 抽出 `printIssues` / `printTopFiles` / `printGate` / `printWarnings`。
  - `exprEnd` → `||` 链改 `OPEN_CH/CLOSE_CH/TERM_CH` 查表对象。

### 红点 0（验证通过项）
- 嵌套函数排除：外层复杂度不被内层分支虚高（实测 outer=2 / inner=8）。
- 字符串/注释伪信号：剥离后不误报（实测 `if/for` 在字符串/注释内 0 命中）。
- 门禁校验：`--max-*` 非整数 `exit 2` 防呆；无效 root `exit 2`。
- 箭头/方法/函数声明三种形态均正确识别（综合计数 3/3）。

## 门禁结果
- 语法零错 ✅
- 14 单测全绿 ✅
- 零依赖无密钥无网络 ✅
- 5MB 跳过防 OOM ✅
- 跨平台（Windows Node 22.22.2）✅
- 安全（只读）✅
- dogfood 自身归零（健康分 100）✅
- forge 真实仓库扫描：30 文件/475 函数/8346 行，报 26 处真实信号（最高复杂度 36、最长 120 行），零误报 ✅
