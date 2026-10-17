#!/usr/bin/env node
'use strict';

/*
 * cycscan — 零依赖单文件 Node CLI · 结构复杂度静态扫描器
 *
 * 聚焦两类高信号、零依赖即可确定性检测的「结构坏味道」：
 *   C1 complex-function  圈复杂度过高（默认 >10，意大利面条函数信号）
 *   C2 long-function     函数过长（默认 >60 行，上帝函数信号）
 *
 * 设计铁律（继承 family 方法沉淀）：
 *   - 纯本地、零依赖、离线、单文件，跨平台（Windows posix 路径）。
 *   - 预处理：逐字符 tokenizer 剥离注释/字符串（保留换行），避免把文档/字符串里的
 *     if/for/switch 误算成真实分支（已修复 awaitscan 跨行块注释塌缩 bug）。
 *   - 函数边界：括号平衡定位函数体；圈复杂度计数「排除嵌套函数内层块」，
 *     只算函数自身表层分支（嵌套函数复杂度归它自己），避免爷爷函数被孙子分支虚高。
 *   - 门禁阈值与检测阈值一律严格校验：非数字 / 非整数 / 负数 / 空串 / 缺值 一律 exit 2，
 *     绝不静默放行。检测阈值（--complexity-threshold 等）尤其关键：NaN 会让
 *     `cplx > NaN` 恒为 false，导致整个检测静默失效、rc 仍为 0（最恶劣的失效形态）。
 *   - 门禁三态：pass(0) / fail(2) / inconclusive(3)。
 *     未配阈值、或扫描输入为空 → inconclusive(3)，绝不谎报「通过」。
 *   - 输入为空时不输出健康分（健康分是有害指标：扫 0 个文件报 100 分会让用户停止思考）。
 *   - 门禁失败消息必须回显真实阈值，不得打印 undefined。
 *   - root 必须 statSync 先验存在且为目录，错误路径不谎报「通过」。
 *   - 大文件（>5MB）跳过，避免 OOM。
 *   - 工具自身所有函数复杂度 < 10、长度 < 60 行（dogfood 必须归零）。
 */

const fs = require('fs');
const path = require('path');

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB 上限，跳过防 OOM
const SCORE_FREE = 1;                   // 每千行允许加权问题数（不扣分）
const SCORE_K = 25;                     // 超出部分扣分系数

// 门禁三态
const GATE_STATE = { PASS: 'pass', FAIL: 'fail', INCONCLUSIVE: 'inconclusive' };
const EXIT_FOR_STATE = { pass: 0, fail: 2, inconclusive: 3 };

// 哨兵异常：帮助 / 用法错误。把「参数错误」与「运行异常」分成两条干净的退出路径，
// 避免 try/catch 只包了一半函数体导致 UsageExit 逃逸成满屏 stack trace + rc=1。
class HelpExit extends Error {}
class UsageExit extends Error {
  constructor(message, code) { super(message); this.code = code === undefined ? 2 : code; }
}

// 规则定义（严重度 / 权重）
const RULES = {
  complexFunction: { id: 'complex-function', severity: 'high',   weight: 3, title: '圈复杂度过高' },
  longFunction:    { id: 'long-function',    severity: 'medium', weight: 2, title: '函数过长' }
};

// 仅针对 JS/TS 生态源文件（不扫 .md/.json，避免文档示例产生伪信号）
const SRC_EXT = new Set([
  '.js', '.mjs', '.cjs', '.jsx',
  '.ts', '.mts', '.cts', '.tsx',
  '.vue', '.svelte'
]);

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out',
  'coverage', '.nyc_output', '.next', '.nuxt', '.svelte-kit', '.cache',
  '.tmp', 'tmp', 'vendor', 'bower_components', '.idea', '.vscode'
]);

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch (_) { return 0; }
}

function countLines(text) {
  if (!text) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') n++;
  return n;
}

// 逐字符剥离注释与字符串（保留换行）：比正则更稳健，不依赖复杂正则配对，
// 能正确处理转义、嵌套引号与跨行模板串，避免示例字符串里的 if/for 被误当真分支。

function skipLineComment(s, i) {
  while (i < s.length && s[i] !== '\n') i++;
  return i;
}

function skipBlockComment(s, i) {
  i += 2;
  while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
  return i + 2;
}

function skipString(s, i, q) {
  i++;
  while (i < s.length) {
    if (s[i] === '\\') { i += 2; continue; }
    if (s[i] === q) return i + 1;
    i++;
  }
  return i;
}

// 把 [from, to) 区间按「非换行变空格、换行原样」填入 out
function fillSpaces(out, s, from, to) {
  for (let k = from; k < to; k++) out.push(s[k] === '\n' ? '\n' : ' ');
}

function stripNoise(code) {
  const out = [];
  const n = code.length;
  let i = 0;
  while (i < n) {
    const c = code[i];
    let next = -1;
    if (c === '/' && code[i + 1] === '/') next = skipLineComment(code, i);
    else if (c === '/' && code[i + 1] === '*') next = skipBlockComment(code, i);
    else if (c === '"' || c === "'" || c === '`') next = skipString(code, i, c);
    if (next >= 0) {
      fillSpaces(out, code, i, next);
      i = next;
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join('');
}

// 括号配对：s[idx] 为开括号 ( [ {，返回其匹配闭括号索引
function matchBracket(s, idx) {
  const open = s[idx];
  const closeMap = { '(': ')', '[': ']', '{': '}' };
  const close = closeMap[open];
  if (!close) return -1;
  let depth = 0;
  for (let i = idx; i < s.length; i++) {
    const c = s[i];
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// 收集所有 { } 块 [start, end]
function braceBlocks(s) {
  const blocks = [];
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{') stack.push(i);
    else if (c === '}') {
      const start = stack.pop();
      if (start !== undefined) blocks.push({ start, end: i });
    }
  }
  return blocks;
}

function lineOf(s, idx) {
  if (idx < 0) return -1;
  let line = 1;
  const limit = Math.min(idx, s.length);
  for (let i = 0; i < limit; i++) if (s[i] === '\n') line++;
  return line;
}

function skipWs(s, i) {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r')) i++;
  return i;
}

// 表达式体结束：从 start 扫到深度 0 的 ; 或换行（用于箭头表达式体）
const OPEN_CH = { '(': 1, '[': 1, '{': 1 };
const CLOSE_CH = { ')': 1, ']': 1, '}': 1 };
const TERM_CH = { ';': 1, '\n': 1 };

function exprEnd(s, start) {
  let depth = 0;
  let i = start;
  while (i < s.length) {
    const c = s[i];
    if (OPEN_CH[c]) depth++;
    else if (CLOSE_CH[c]) { depth--; if (depth < 0) return i - 1; }
    else if (TERM_CH[c]) { if (depth === 0) return i - 1; }
    i++;
  }
  return s.length - 1;
}

// ---------------------------------------------------------------------------
// 函数边界检测（括号平衡 + 嵌套排除）
// ---------------------------------------------------------------------------

// 关键字（用于区分「方法签名」与 「if/for/while/switch/catch 等控制结构调用」）
const CTRL_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'do', 'else', 'try', 'finally',
  'with', 'function', 'return', 'typeof', 'new', 'delete', 'void', 'in',
  'of', 'await', 'async', 'yield', 'class', 'extends', 'super', 'this',
  'default', 'case', 'var', 'let', 'const', 'throw', 'typeof'
]);

// 从 ')' 位置 (closeIdx) 反向找匹配的 '('
function findParamOpen(s, closeIdx) {
  let depth = 0;
  for (let k = closeIdx; k >= 0; k--) {
    if (s[k] === ')') depth++;
    else if (s[k] === '(') { depth--; if (depth === 0) return k; }
  }
  return -1;
}

// 1) function 声明 / 表达式（含 async function、generator *）
function findFunctionKeyword(s, pushFn) {
  const fnRe = /\bfunction\b/g;
  let m;
  fnRe.lastIndex = 0;
  while ((m = fnRe.exec(s)) !== null) {
    if (s[m.index - 1] === '.') continue; // obj.function(...) 调用，跳过
    let i = m.index + 'function'.length;
    i = skipWs(s, i);
    if (s[i] === '*') i = skipWs(s, i + 1);          // generator
    const nm = /^[A-Za-z0-9_$]*/.exec(s.substr(i));
    if (nm) i += nm[0].length;                        // 可选函数名
    i = skipWs(s, i);
    if (s[i] !== '(') continue;
    const close = matchBracket(s, i);
    if (close < 0) continue;
    const b = skipWs(s, close + 1);
    if (s[b] !== '{') continue;
    const be = matchBracket(s, b);
    if (be > b) pushFn(m.index, b + 1, be - 1);
  }
}

// 2) 箭头函数 (params) => ... / param => ...
function findArrows(s, pushFn) {
  const arrowRe = /=>/g;
  let am;
  arrowRe.lastIndex = 0;
  while ((am = arrowRe.exec(s)) !== null) {
    const arrowPos = am.index;
    let j = arrowPos - 1;
    while (j >= 0 && /\s/.test(s[j])) j--;
    const openP = s[j] === ')' ? findParamOpen(s, j) : -1;
    const b = skipWs(s, arrowPos + 2);
    if (s[b] === '{') {
      const be = matchBracket(s, b);
      if (be > b) pushFn(openP >= 0 ? openP : arrowPos, b + 1, be - 1);
    } else {
      const end = exprEnd(s, b);
      if (end > b) pushFn(openP >= 0 ? openP : arrowPos, b, end);
    }
  }
}

// 3) 方法简写 name(params) { （class 方法 / 对象方法简写），排除属性(:)/调用(.)
function findMethods(s, pushFn) {
  const methodRe = /([A-Za-z_$][\w$]*)\s*\(/g;
  let mm;
  methodRe.lastIndex = 0;
  while ((mm = methodRe.exec(s)) !== null) {
    const name = mm[1];
    if (CTRL_KEYWORDS.has(name)) continue;
    const openParen = mm.index + mm[0].length - 1;
    const before = s[mm.index - 1];
    if (before === ':' || before === '.') continue; // 对象属性 / 方法调用
    const close = matchBracket(s, openParen);
    if (close < 0) continue;
    const b = skipWs(s, close + 1);
    if (s[b] !== '{') continue;
    const be = matchBracket(s, b);
    if (be > b) pushFn(mm.index, b + 1, be - 1);
  }
}

// 返回所有函数体 [{headerStart, bodyStart, bodyEnd}]
function findFunctions(s) {
  const found = {};
  const out = [];
  function pushFn(headerStart, bodyStart, bodyEnd) {
    const key = bodyStart + ':' + bodyEnd;
    if (found[key]) return;
    found[key] = true;
    out.push({ headerStart, bodyStart, bodyEnd });
  }
  findFunctionKeyword(s, pushFn);
  findArrows(s, pushFn);
  findMethods(s, pushFn);
  return out;
}

// 判断 idx 是否落在任一「严格嵌套在 [outerStart,outerEnd] 内」的函数体内
function isInsideNestedFn(idx, allFns, outerStart, outerEnd) {
  for (let i = 0; i < allFns.length; i++) {
    const f = allFns[i];
    if (f.bodyStart > outerStart && f.bodyEnd < outerEnd && idx > f.bodyStart && idx < f.bodyEnd) {
      return true;
    }
  }
  return false;
}

// 圈复杂度（McCabe 近似）：基础 1 + 分支决策点（排除嵌套函数内层块）
const DECISION_RE = /\b(if|for|while|do|switch|catch|case)\b|\|\||&&|\?/g;

function countComplexity(s, fn, allFns) {
  let count = 1; // 基础复杂度
  DECISION_RE.lastIndex = 0;
  let d;
  while ((d = DECISION_RE.exec(s)) !== null) {
    const idx = d.index;
    if (idx < fn.bodyStart || idx > fn.bodyEnd) continue;
    if (isInsideNestedFn(idx, allFns, fn.bodyStart, fn.bodyEnd)) continue;
    count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// 检测
// ---------------------------------------------------------------------------

function detectInText(s, file, thresholds) {
  const issues = [];
  const fns = findFunctions(s);
  let maxComplexity = 0;
  let maxLines = 0;

  for (let i = 0; i < fns.length; i++) {
    const fn = fns[i];
    const cplx = countComplexity(s, fn, fns);
    const len = lineOf(s, fn.bodyEnd) - lineOf(s, fn.headerStart) + 1;
    if (cplx > maxComplexity) maxComplexity = cplx;
    if (len > maxLines) maxLines = len;

    if (cplx > thresholds.complexity) {
      issues.push({
        file, line: lineOf(s, fn.headerStart), rule: RULES.complexFunction,
        message: '圈复杂度 ' + cplx + ' > 阈值 ' + thresholds.complexity + '（分支过多，建议拆函数 / 早返回 / 查表）',
        suggest: '把大函数按职责拆小；用提前 return 减少嵌套；用 Map/策略表替代长 if-else。'
      });
    }
    if (len > thresholds.lines) {
      issues.push({
        file, line: lineOf(s, fn.headerStart), rule: RULES.longFunction,
        message: '函数长度 ' + len + ' 行 > 阈值 ' + thresholds.lines + ' 行（过长，可读性差）',
        suggest: '把独立子逻辑抽成命名函数；一次函数只做一件事。'
      });
    }
  }

  return { issues, maxComplexity, maxLines, functionCount: fns.length };
}

function scanFile(full, thresholds) {
  let text;
  try { text = fs.readFileSync(full, 'utf8'); } catch (_) { return null; }
  const s = stripNoise(text);
  const res = detectInText(s, full, thresholds);
  res.lineCount = countLines(text);
  return res;
}

function scanRoot(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); }
    catch (_) { continue; }
    entries.forEach(e => {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
        return;
      }
      if (!e.isFile()) return;
      const ext = path.extname(e.name).toLowerCase();
      if (!SRC_EXT.has(ext)) return;
      if (fileSize(full) > MAX_FILE_BYTES) return;
      files.push(full);
    });
  }
  return files;
}

function topN(map, n) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([p, c]) => ({ path: p, count: c }));
}

// 把单文件结果累加进累加器（拆函数以压低 analyze 自身复杂度 —— 本工具 dogfood 必须归零）
function accumulate(acc, file, res) {
  acc.srcLines += res.lineCount;
  acc.functionCount += res.functionCount;
  if (res.maxComplexity > acc.maxComplexity) acc.maxComplexity = res.maxComplexity;
  if (res.maxLines > acc.maxLines) acc.maxLines = res.maxLines;
  if (!res.issues.length) return;
  acc.byFile[file] = (acc.byFile[file] || 0) + res.issues.length;
  for (const it of res.issues) {
    acc.byRule[it.rule.id]++;
    acc.bySeverity[it.rule.severity]++;
    acc.totalWeighted += it.rule.weight;
    acc.issues.push(it);
  }
}

function newAccumulator() {
  const byRule = {};
  for (const r of Object.values(RULES)) byRule[r.id] = 0;
  return {
    issues: [], byRule, byFile: {},
    bySeverity: { high: 0, medium: 0, low: 0 },
    totalWeighted: 0, srcLines: 0, maxComplexity: 0, maxLines: 0, functionCount: 0
  };
}

function sortIssues(issues) {
  const sev = { high: 0, medium: 1, low: 2 };
  issues.sort((a, b) => {
    if (sev[a.rule.severity] !== sev[b.rule.severity]) return sev[a.rule.severity] - sev[b.rule.severity];
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.line - b.line;
  });
}

function analyze(root, thresholds) {
  const files = scanRoot(root);
  const acc = newAccumulator();
  for (let i = 0; i < files.length; i++) {
    const res = scanFile(files[i], thresholds);
    if (res) accumulate(acc, files[i], res);
  }

  const weightedDensity = acc.srcLines > 0 ? acc.totalWeighted / (acc.srcLines / 1000) : 0;
  // 健康分是有害指标：扫描输入为空时没有健康可言，返回 null 而不是 100。
  const basisComplete = files.length > 0 && acc.srcLines > 0;
  const score = basisComplete ? computeScore(weightedDensity) : { score: null, verdict: '无法评估' };
  sortIssues(acc.issues);

  return {
    root, files: files.length, functionCount: acc.functionCount, srcLines: acc.srcLines,
    issueCount: acc.issues.length, totalWeighted: acc.totalWeighted,
    byRule: acc.byRule, bySeverity: acc.bySeverity,
    weightedDensity: Number(weightedDensity.toFixed(2)),
    maxComplexity: acc.maxComplexity, maxLines: acc.maxLines, basisComplete,
    healthScore: score.score, verdict: score.verdict,
    topFiles: topN(acc.byFile, 10), issues: acc.issues
  };
}

// ---------------------------------------------------------------------------
// 健康分
// ---------------------------------------------------------------------------

function computeScore(weightedDensity) {
  const over = Math.max(0, weightedDensity - SCORE_FREE);
  const penalty = Math.min(100, over * SCORE_K);
  const score = Math.max(0, Math.min(100, Math.round(100 - penalty)));
  let verdict = '健康';
  if (score < 40) verdict = '结构风险高';
  else if (score < 70) verdict = '结构风险偏高';
  else if (score < 90) verdict = '基本健康';
  return { score, verdict };
}

// ---------------------------------------------------------------------------
// 警告 + 门禁
// ---------------------------------------------------------------------------

function buildWarnings(a) {
  const warnings = [];
  if (a.files === 0) warnings.push('no-source: 未扫描到任何 JS/TS 源文件');
  if (a.bySeverity.high > 0) {
    warnings.push('has-high-severity: 存在圈复杂度过高函数共 ' + a.bySeverity.high + ' 处');
  }
  return warnings;
}

// 门禁检查表（避免重复分支把 applyGate 自身复杂度拉爆）
// 消息函数的签名是 (a, threshold) —— 阈值必须由调用方从 args 传入。
// 旧实现写成 a => ... + a.maxHigh，而阈值实际存在 args 上、不在 a 上，
// 导致所有失败消息回显 `undefined`；--max-complexity/--max-lines 更荒唐：
// 两边打印同一个实测值（`16 > --max-complexity 16`），等于什么都没说。
const GATE_CHECKS = [
  ['maxHigh', '--max-high', a => a.bySeverity.high,
    (a, t) => '高危问题 ' + a.bySeverity.high + ' > --max-high ' + t],
  ['maxMedium', '--max-medium', a => a.bySeverity.medium,
    (a, t) => '中危问题 ' + a.bySeverity.medium + ' > --max-medium ' + t],
  ['maxIssues', '--max-issues', a => a.issueCount,
    (a, t) => '总问题数 ' + a.issueCount + ' > --max-issues ' + t],
  ['maxComplexity', '--max-complexity', a => a.maxComplexity,
    (a, t) => '最高圈复杂度 ' + a.maxComplexity + ' > --max-complexity ' + t],
  ['maxLines', '--max-lines', a => a.maxLines,
    (a, t) => '最长函数 ' + a.maxLines + ' 行 > --max-lines ' + t]
];

/**
 * 门禁三态判定。
 * 判定顺序：① 是否配了阈值 → ② 输入是否可信 → ③ 是否有不达标项。
 * 顺序不能颠倒：输入为空时先报「通过」是本家族最恶劣的失败模式（假绿灯）。
 */
// 门禁开关清单：用数组.some 而非一串 ||，避免把 buildGateState 自身复杂度顶爆
const GATE_OPTS = ['maxHigh', 'maxMedium', 'maxIssues', 'maxComplexity', 'maxLines'];

function isGateConfigured(opts) {
  return GATE_OPTS.some(k => opts[k] !== undefined) ||
    !!opts.failOnHigh || !!opts.failOnIssues;
}

function buildGateState({ files, srcLines, basisComplete, opts, gate }) {
  const configured = isGateConfigured(opts);
  if (!configured) {
    return {
      state: GATE_STATE.INCONCLUSIVE, configured: false,
      reason: '未配置任何门禁阈值；本次输出一律不构成「门禁通过」结论。' +
              '请显式传入 --max-high / --max-medium / --max-issues / --max-complexity / --max-lines / --fail-on-high / --fail-on-issues 之一。'
    };
  }
  if (files === 0) {
    return {
      state: GATE_STATE.INCONCLUSIVE, configured: true,
      reason: '扫描输入为空：0 个源文件，门禁结论不可信（而非「通过」）。' +
              '请确认 --root 指向真实源码目录，且目录下有 .js/.ts/.jsx/.tsx/.vue/.svelte 文件。'
    };
  }
  if (!basisComplete || srcLines === 0) {
    return {
      state: GATE_STATE.INCONCLUSIVE, configured: true,
      reason: '扫描到的文件全部无可解析内容（总行数 0），门禁结论不可信。'
    };
  }
  if (gate && gate.length) {
    return { state: GATE_STATE.FAIL, configured: true, reason: '存在 ' + gate.length + ' 项不达标。' };
  }
  return { state: GATE_STATE.PASS, configured: true, reason: '全部已配置门禁项达标。' };
}

function exitCodeFor(state) {
  return EXIT_FOR_STATE[state] === undefined ? 3 : EXIT_FOR_STATE[state];
}

/** 计算门禁不达标项列表（不含三态判定）。阈值合法性已在 parseArgs 阶段拦掉。 */
function collectGateFailures(a, args, warnings) {
  const gate = [];
  for (let i = 0; i < GATE_CHECKS.length; i++) {
    const key = GATE_CHECKS[i][0];
    if (args[key] === undefined) continue;
    const threshold = args[key];
    if (GATE_CHECKS[i][2](a) > threshold) gate.push(GATE_CHECKS[i][3](a, threshold));
  }
  if (args.failOnHigh && a.bySeverity.high > 0) {
    gate.push('存在 ' + a.bySeverity.high + ' 处高危问题');
  }
  if (args.failOnIssues && warnings.length > 0) {
    gate.push('存在 ' + warnings.length + ' 条警告');
  }
  return gate;
}

/** 兼容旧调用：返回 { code, gate, state }，code 由三态推导。 */
function applyGate(a, args, warnings) {
  const gate = collectGateFailures(a, args, warnings || []);
  const state = buildGateState({
    files: a.files, srcLines: a.srcLines,
    basisComplete: a.basisComplete !== undefined ? a.basisComplete : (a.files > 0 && a.srcLines > 0),
    opts: args, gate
  });
  return { code: exitCodeFor(state.state), gate, state };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const NUM_FLAGS = {
  '--complexity-threshold': 'complexityThreshold',
  '--lines-threshold': 'linesThreshold',
  '--max-high': 'maxHigh',
  '--max-medium': 'maxMedium',
  '--max-issues': 'maxIssues',
  '--max-complexity': 'maxComplexity',
  '--max-lines': 'maxLines'
};

const BOOL_FLAGS = {
  '--json': 1, '--version': 1, '-V': 1, '--help': 1, '-h': 1,
  '--fail-on-high': 1, '--fail-on-issues': 1
};

function usageError(msg) {
  throw new UsageExit('[cycscan] 错误：' + msg, 2);
}

/**
 * 严格数值参数校验。
 * 陷阱：Number('') === 0、parseInt('5abc') === 5、parseInt('abc') === NaN。
 * 最后一条对本工具尤其致命：--complexity-threshold abc 会让阈值变成 NaN，
 * 而 `cplx > NaN` 恒为 false —— 整个检测静默失效，一个问题都报不出来，rc 仍为 0。
 */
function parseNumberFlag(flag, raw, { min }) {
  if (raw === undefined) usageError(flag + ' 缺少数值参数');
  if (typeof raw !== 'string' || raw.trim() === '') usageError(flag + ' 需要数值参数（收到空值）');
  if (raw.trim().startsWith('-')) usageError(flag + ' 需要非负数（收到: ' + raw + '）');
  // 尾随垃圾检测：'5abc' / '1.2.3' / '0x10'
  if (!/^\d+$/.test(raw.trim())) {
    usageError(flag + ' 需要十进制非负整数（收到: ' + raw + '）');
  }
  const v = Number(raw);
  if (!Number.isFinite(v)) usageError(flag + ' 需要有限数字（收到: ' + raw + '）');
  if (!Number.isInteger(v)) usageError(flag + ' 需要整数（收到: ' + raw + '）');
  if (v < min) usageError(flag + ' 需要 >= ' + min + ' 的整数（收到: ' + raw + '）');
  return v;
}

// 检测阈值与门禁阈值的最小合法值不同：
// 检测阈值 0 是合法的（极端严格，报告一切）；门禁阈值 0 也是合法的（禁止任何一项）。
const MIN_BY_FLAG = {
  '--complexity-threshold': 1,
  '--lines-threshold': 1
};

function setBool(args, a) {
  if (a === '--json') args.json = true;
  else if (a === '--version' || a === '-V') args.version = true;
  else if (a === '--help' || a === '-h') args.help = true;
  else if (a === '--fail-on-high') args.failOnHigh = true;
  else if (a === '--fail-on-issues') args.failOnIssues = true;
}

// 解析 --root（拆函数以压低 parseArgs 自身复杂度 —— 本工具 dogfood 必须归零）
function parseRootFlag(raw) {
  if (raw === undefined) usageError('--root 缺少目录参数');
  if (typeof raw !== 'string' || raw.trim() === '') usageError('--root 需要非空目录路径');
  if (raw.startsWith('-')) usageError('--root 缺少目录参数（收到标志: ' + raw + '）');
  return raw;
}

// 兜底也必须报错：拼错的门禁参数 = 门禁不存在，绝不静默吞掉
function rejectUnknown(a) {
  if (a.startsWith('-')) {
    usageError('未知选项: ' + a + '（用 --help 查看可用选项；门禁参数写错 = 门禁不存在）');
  }
  usageError('未知参数: ' + a + '（位置参数只接受 scan）');
}

function parseArgs(argv) {
  const args = { _: [], root: process.cwd(), json: false,
    complexityThreshold: 10, linesThreshold: 60 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a in NUM_FLAGS) {
      const min = MIN_BY_FLAG[a] === undefined ? 0 : MIN_BY_FLAG[a];
      args[NUM_FLAGS[a]] = parseNumberFlag(a, argv[++i], { min });
    } else if (a === '--root') {
      args.root = parseRootFlag(argv[++i]);
    } else if (a === 'scan') {
      args._.push(a);
    } else if (a in BOOL_FLAGS) {
      setBool(args, a);
    } else {
      rejectUnknown(a);
    }
  }
  return args;
}

function packageVersion() {
  const pkg = readJsonSafe(path.join(__dirname, 'package.json'));
  return pkg && pkg.version ? pkg.version : '0.0.0';
}

function printHelp() {
  console.log([
    'cycscan — 零依赖单文件结构复杂度静态扫描 CLI',
    '',
    '版本: ' + packageVersion(),
    '',
    '用法:',
    '  cycscan [scan] [--root <dir>] [--json]',
    '              [--complexity-threshold <n>] [--lines-threshold <n>]',
    '              [--max-high <n>] [--max-medium <n>] [--max-issues <n>]',
    '              [--max-complexity <n>] [--max-lines <n>]',
    '              [--fail-on-high] [--fail-on-issues]',
    '',
    '  scan    静态扫描（默认）：检测两类高信号结构坏味道',
    '         C1 complex-function  圈复杂度过高（默认 >10）',
    '         C2 long-function     函数过长（默认 >60 行）',
    '',
    '检测阈值（调松/调严扫描灵敏度；[>= 1 的整数]）:',
    '  --complexity-threshold <n>  圈复杂度报警阈值（默认 10）',
    '  --lines-threshold <n>       函数长度报警阈值（默认 60 行）',
    '',
    '门禁（阈值非法一律 exit 2，绝不静默放行；[>= 0 的整数]）:',
    '  --max-high <n>     高危问题(圈复杂度过高) 超过则失败',
    '  --max-medium <n>   中危问题(函数过长) 超过则失败',
    '  --max-issues <n>   总问题数超过则失败',
    '  --max-complexity <n>  最高圈复杂度超过则失败（CI 最常用）',
    '  --max-lines <n>    最长函数超过则失败',
    '  --fail-on-high     出现任何圈复杂度过高即失败',
    '  --fail-on-issues   存在任何警告即失败',
    '',
    '退出码契约:',
    '  0  pass          已配置门禁且全部达标',
    '  2  fail          已配置门禁且存在不达标项 / 参数非法',
    '  3  inconclusive  未配置门禁阈值，或扫描输入为空 —— 结论不可信，**不等于通过**',
    '',
    '其他:',
    '  --version, -V       打印版本号',
    '  --help, -h          打印本帮助',
    '',
    '健康分：每千行允许加权问题 ' + SCORE_FREE + ' 不扣分，超出按系数 ' + SCORE_K + ' 扣，0-100。',
    '      扫描输入为空时健康分为 null（无法评估），不会给出 100 分误导你。'
  ].join('\n'));
}

function printIssues(issues, root) {
  console.log('  问题清单:');
  for (let i = 0; i < issues.length; i++) {
    const it = issues[i];
    const rel = path.relative(root, it.file) || it.file;
    console.log('    [' + it.rule.severity + '] ' + rel + ':' + it.line + '  ' + it.rule.title);
    console.log('         ' + it.message);
  }
}

function printTopFiles(topFiles) {
  console.log('  问题 Top 文件:');
  for (let i = 0; i < topFiles.length; i++) {
    console.log('    - ' + topFiles[i].path + ' (' + topFiles[i].count + ')');
  }
}

function printGate(gate, gateState) {
  // 门禁状态始终显式打印，包括 pass —— 沉默的绿灯是假绿灯的温床。
  const label = gateState.state === GATE_STATE.PASS ? '通过'
    : gateState.state === GATE_STATE.FAIL ? '失败'
    : '未决（结论不可信，不等于通过）';
  console.log('  门禁: ' + label + '  [state=' + gateState.state + ' configured=' + gateState.configured + ']');
  console.log('    理由: ' + gateState.reason);
  if (gate && gate.length) {
    for (let i = 0; i < gate.length; i++) console.log('    [失败] ' + gate[i]);
  }
}

function printWarnings(warnings) {
  if (warnings.length) {
    console.log('  警告:');
    for (let i = 0; i < warnings.length; i++) console.log('    [警告] ' + warnings[i]);
  } else {
    console.log('  警告: 无');
  }
}

function printHeadline(a) {
  console.log('cycscan · 结构复杂度扫描 · root=' + a.root);
  console.log('  扫描源文件   : ' + a.files);
  console.log('  函数总数     : ' + a.functionCount);
  console.log('  源码总行数   : ' + a.srcLines);
  console.log('  问题总数     : ' + a.issueCount + ' (加权 ' + a.totalWeighted + ')');
  console.log('  最高圈复杂度 : ' + a.maxComplexity);
  console.log('  最长函数     : ' + a.maxLines + ' 行');
  console.log('  严重度分布   : high=' + a.bySeverity.high +
    ' medium=' + a.bySeverity.medium + ' low=' + a.bySeverity.low);
  const ruleLine = Object.keys(a.byRule).filter(k => a.byRule[k] > 0)
    .map(k => k + '=' + a.byRule[k]).join('  ');
  if (ruleLine) console.log('  规则明细     : ' + ruleLine);
  if (a.issues.length) printIssues(a.issues, a.root);
  if (a.topFiles.length) printTopFiles(a.topFiles);
}

function printScore(a) {
  // 扫描输入为空时健康分为 null（无法评估），不给出 100 分误导用户
  if (a.basisComplete) {
    console.log('  健康分       : ' + a.healthScore + ' / 100  [' + a.verdict + ']');
  } else {
    console.log('  健康分       : 无法评估（扫描输入为空，扫描 0 个源文件）');
  }
  if (a.elapsed !== undefined) console.log('  耗时         : ' + a.elapsed + ' ms');
}

function printReport(a, warnings, gate, gateState) {
  printHeadline(a);
  printScore(a);
  printWarnings(warnings);
  printGate(gate, gateState);
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { printHelp(); return 0; }
  if (args.version) {
    console.log('cycscan ' + packageVersion());
    return 0;
  }

  const root = path.resolve(args.root);
  if (!isDir(root)) {
    usageError('root 不是有效目录 -> ' + root);
  }

  const thresholds = { complexity: args.complexityThreshold, lines: args.linesThreshold };
  const t0 = Date.now();
  const a = analyze(root, thresholds);
  a.elapsed = Date.now() - t0;
  const warnings = buildWarnings(a);
  const gate = collectGateFailures(a, args, warnings);
  const gateState = buildGateState({
    files: a.files, srcLines: a.srcLines, basisComplete: a.basisComplete,
    opts: args, gate
  });
  const code = exitCodeFor(gateState.state);

  if (args.json) {
    const report = {
      mode: 'scan', root, files: a.files, functionCount: a.functionCount, srcLines: a.srcLines,
      issueCount: a.issueCount, totalWeighted: a.totalWeighted,
      byRule: a.byRule, bySeverity: a.bySeverity, weightedDensity: a.weightedDensity,
      maxComplexity: a.maxComplexity, maxLines: a.maxLines,
      basisComplete: a.basisComplete,
      healthScore: a.healthScore, verdict: a.verdict,
      topFiles: a.topFiles, issues: a.issues, elapsed: a.elapsed, warnings,
      gate: {
        state: gateState.state,
        configured: gateState.configured,
        reason: gateState.reason,
        failures: gate
      }
    };
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(a, warnings, gate, gateState);
  }
  return code;
}

function run(argv) {
  try {
    return main(argv);
  } catch (e) {
    if (e instanceof HelpExit) return 0;
    if (e instanceof UsageExit) {
      console.error(e.message);
      process.exitCode = e.code;
      return e.code;
    }
    console.error('[cycscan] 运行异常: ' + (e && e.message));
    process.exitCode = 1;
    return 1;
  }
}

module.exports = {
  RULES, SRC_EXT, SKIP_DIRS, MAX_FILE_BYTES, SCORE_FREE, SCORE_K,
  NUM_FLAGS, BOOL_FLAGS, GATE_CHECKS, MIN_BY_FLAG,
  GATE_STATE, EXIT_FOR_STATE, HelpExit, UsageExit,
  readJsonSafe, isDir, isFile, fileSize, countLines, packageVersion,
  skipLineComment, skipBlockComment, skipString, fillSpaces, stripNoise,
  matchBracket, braceBlocks, lineOf, skipWs, exprEnd,
  CTRL_KEYWORDS, findParamOpen, findFunctionKeyword, findArrows, findMethods,
  findFunctions, isInsideNestedFn, countComplexity, detectInText,
  scanFile, scanRoot, accumulate, newAccumulator, sortIssues, analyze, computeScore,
  buildWarnings, GATE_OPTS, isGateConfigured, buildGateState, exitCodeFor, collectGateFailures, applyGate,
  parseArgs, setBool, parseNumberFlag,
  printIssues, printTopFiles, printGate, printWarnings, printHeadline, printScore, printReport, main, run
};

if (require.main === module) {
  // 用 exitCode 而非 process.exit()：后者会截断异步刷写的 stdout，导致 --json 输出残缺。
  process.exitCode = run(process.argv.slice(2));
}
