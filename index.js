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
 *   - 门禁阈值一律 Number.isFinite 校验，非整数直接 exit 2，绝不静默放行。
 *   - root 必须 statSync 先验存在且为目录，错误路径不谎报「通过」。
 *   - 大文件（>5MB）跳过，避免 OOM。
 *   - 工具自身所有函数复杂度 < 10、长度 < 60 行（dogfood 必须归零）。
 */

const fs = require('fs');
const path = require('path');

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB 上限，跳过防 OOM
const SCORE_FREE = 1;                   // 每千行允许加权问题数（不扣分）
const SCORE_K = 25;                     // 超出部分扣分系数

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

function analyze(root, thresholds) {
  const files = scanRoot(root);
  const issues = [];
  const byRule = {};
  const bySeverity = { high: 0, medium: 0, low: 0 };
  const byFile = {};
  let totalWeighted = 0;
  let srcLines = 0;
  let maxComplexity = 0;
  let maxLines = 0;
  let functionCount = 0;
  for (const r of Object.values(RULES)) byRule[r.id] = 0;

  for (let i = 0; i < files.length; i++) {
    const res = scanFile(files[i], thresholds);
    if (!res) continue;
    srcLines += res.lineCount;
    functionCount += res.functionCount;
    if (res.maxComplexity > maxComplexity) maxComplexity = res.maxComplexity;
    if (res.maxLines > maxLines) maxLines = res.maxLines;
    if (res.issues.length) {
      byFile[files[i]] = (byFile[files[i]] || 0) + res.issues.length;
      res.issues.forEach(it => {
        byRule[it.rule.id]++;
        bySeverity[it.rule.severity]++;
        totalWeighted += it.rule.weight;
        issues.push(it);
      });
    }
  }

  const weightedDensity = srcLines > 0 ? totalWeighted / (srcLines / 1000) : 0;
  const score = computeScore(weightedDensity);
  issues.sort((a, b) => {
    const sev = { high: 0, medium: 1, low: 2 };
    if (sev[a.rule.severity] !== sev[b.rule.severity]) return sev[a.rule.severity] - sev[b.rule.severity];
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.line - b.line;
  });

  return {
    root, files: files.length, functionCount, srcLines, issueCount: issues.length,
    totalWeighted, byRule, bySeverity, weightedDensity: Number(weightedDensity.toFixed(2)),
    maxComplexity, maxLines,
    healthScore: score.score, verdict: score.verdict,
    topFiles: topN(byFile, 10), issues
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
const GATE_CHECKS = [
  ['maxHigh', '--max-high', a => a.bySeverity.high,
    a => '高危问题 ' + a.bySeverity.high + ' > --max-high ' + a.maxHigh],
  ['maxMedium', '--max-medium', a => a.bySeverity.medium,
    a => '中危问题 ' + a.bySeverity.medium + ' > --max-medium ' + a.maxMedium],
  ['maxIssues', '--max-issues', a => a.issueCount,
    a => '总问题数 ' + a.issueCount + ' > --max-issues ' + a.maxIssues],
  ['maxComplexity', '--max-complexity', a => a.maxComplexity,
    a => '最高圈复杂度 ' + a.maxComplexity + ' > --max-complexity ' + a.maxComplexity],
  ['maxLines', '--max-lines', a => a.maxLines,
    a => '最长函数 ' + a.maxLines + ' 行 > --max-lines ' + a.maxLines]
];

function applyGate(a, args, warnings) {
  const gate = [];
  for (let i = 0; i < GATE_CHECKS.length; i++) {
    const key = GATE_CHECKS[i][0];
    if (args[key] === undefined) continue;
    if (!Number.isFinite(args[key])) {
      console.error('[cycscan] 错误：' + GATE_CHECKS[i][1] + ' 必须为整数');
      return { code: 2, gate: null };
    }
    if (GATE_CHECKS[i][2](a) > args[key]) gate.push(GATE_CHECKS[i][3](a));
  }
  if (args.failOnHigh && a.bySeverity.high > 0) {
    gate.push('存在 ' + a.bySeverity.high + ' 处高危问题');
  }
  if (args.failOnIssues && warnings.length > 0) {
    gate.push('存在 ' + warnings.length + ' 条警告');
  }
  return { code: gate.length ? 2 : 0, gate };
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

const STR_FLAGS = {
  '--root': 'root'
};

const BOOL_FLAGS = {
  '--json': 1, '--version': 1, '-V': 1, '--help': 1, '-h': 1,
  '--fail-on-high': 1, '--fail-on-issues': 1
};

function setBool(args, a) {
  if (a === '--json') args.json = true;
  else if (a === '--version' || a === '-V') args.version = true;
  else if (a === '--help' || a === '-h') args.help = true;
  else if (a === '--fail-on-high') args.failOnHigh = true;
  else if (a === '--fail-on-issues') args.failOnIssues = true;
}

function parseArgs(argv) {
  const args = { _: [], root: process.cwd(), json: false,
    complexityThreshold: 10, linesThreshold: 60 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a in NUM_FLAGS) { args[NUM_FLAGS[a]] = parseInt(argv[++i], 10); continue; }
    if (a in STR_FLAGS) { args[STR_FLAGS[a]] = argv[++i]; continue; }
    if (a === 'scan') { args._.push(a); continue; }
    if (a in BOOL_FLAGS) { setBool(args, a); continue; }
  }
  return args;
}

function printHelp() {
  console.log([
    'cycscan — 零依赖单文件结构复杂度静态扫描 CLI',
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
    '检测阈值（调松/调严扫描灵敏度）：',
    '  --complexity-threshold <n>  圈复杂度报警阈值（默认 10）',
    '  --lines-threshold <n>       函数长度报警阈值（默认 60 行）',
    '',
    '门禁（非整数阈值直接 exit 2）：',
    '  --max-high <n>     高危问题(圈复杂度过高) 超过则失败',
    '  --max-medium <n>   中危问题(函数过长) 超过则失败',
    '  --max-issues <n>   总问题数超过则失败',
    '  --max-complexity <n>  最高圈复杂度超过则失败（CI 最常用）',
    '  --max-lines <n>    最长函数超过则失败',
    '  --fail-on-high     出现任何圈复杂度过高即失败',
    '  --fail-on-issues   存在任何警告即失败',
    '',
    '其他：',
    '  --version, -V       打印版本号',
    '  --help, -h          打印本帮助',
    '',
    '健康分：每千行允许加权问题 ' + SCORE_FREE + ' 不扣分，超出按系数 ' + SCORE_K + ' 扣，0-100。'
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

function printGate(gate) {
  if (!gate) return;
  if (gate.length) {
    console.log('  门禁: 失败');
    for (let i = 0; i < gate.length; i++) console.log('    [失败] ' + gate[i]);
  } else {
    console.log('  门禁: 通过');
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

function printReport(a, warnings, gate) {
  console.log('cycscan · 结构复杂度扫描 · root=' + a.root);
  console.log('  扫描源文件   : ' + a.files);
  console.log('  函数总数     : ' + a.functionCount);
  console.log('  源码总行数   : ' + a.srcLines);
  console.log('  问题总数     : ' + a.issueCount + ' (加权 ' + a.totalWeighted + ')');
  console.log('  最高圈复杂度 : ' + a.maxComplexity);
  console.log('  最长函数     : ' + a.maxLines + ' 行');
  console.log('  严重度分布   : high=' + a.bySeverity.high + ' medium=' + a.bySeverity.medium + ' low=' + a.bySeverity.low);
  const ruleLine = Object.keys(a.byRule).filter(k => a.byRule[k] > 0)
    .map(k => k + '=' + a.byRule[k]).join('  ');
  if (ruleLine) console.log('  规则明细     : ' + ruleLine);
  if (a.issues.length) printIssues(a.issues, a.root);
  if (a.topFiles.length) printTopFiles(a.topFiles);
  console.log('  健康分       : ' + a.healthScore + ' / 100  [' + a.verdict + ']');
  if (a.elapsed !== undefined) console.log('  耗时         : ' + a.elapsed + ' ms');
  printWarnings(warnings);
  printGate(gate);
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { printHelp(); return 0; }
  if (args.version) {
    const pkg = readJsonSafe(path.join(__dirname, 'package.json'));
    console.log('cycscan ' + (pkg && pkg.version ? pkg.version : '1.0.0'));
    return 0;
  }

  const root = path.resolve(args.root);
  if (!isDir(root)) {
    console.error('[cycscan] 错误：root 不是有效目录 -> ' + root);
    return 2;
  }

  const thresholds = { complexity: args.complexityThreshold, lines: args.linesThreshold };
  const t0 = Date.now();
  const a = analyze(root, thresholds);
  a.elapsed = Date.now() - t0;
  const warnings = buildWarnings(a);
  const gateRes = applyGate(a, args, warnings);
  if (gateRes.gate === null) return gateRes.code; // 阈值非法已报错

  if (args.json) {
    const report = {
      mode: 'scan', root, files: a.files, functionCount: a.functionCount, srcLines: a.srcLines,
      issueCount: a.issueCount, totalWeighted: a.totalWeighted,
      byRule: a.byRule, bySeverity: a.bySeverity, weightedDensity: a.weightedDensity,
      maxComplexity: a.maxComplexity, maxLines: a.maxLines,
      healthScore: a.healthScore, verdict: a.verdict,
      topFiles: a.topFiles, issues: a.issues, elapsed: a.elapsed, warnings,
      gate: { passed: gateRes.gate.length === 0, failures: gateRes.gate }
    };
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(a, warnings, gateRes.gate);
  }
  return gateRes.code;
}

module.exports = {
  RULES, SRC_EXT, SKIP_DIRS, MAX_FILE_BYTES, SCORE_FREE, SCORE_K,
  NUM_FLAGS, STR_FLAGS, BOOL_FLAGS, GATE_CHECKS,
  readJsonSafe, isDir, isFile, fileSize, countLines,
  skipLineComment, skipBlockComment, skipString, fillSpaces, stripNoise,
  matchBracket, braceBlocks, lineOf, skipWs, exprEnd,
  CTRL_KEYWORDS, findParamOpen, findFunctionKeyword, findArrows, findMethods,
  findFunctions, isInsideNestedFn, countComplexity, detectInText,
  scanFile, scanRoot, analyze, computeScore,
  buildWarnings, applyGate, parseArgs, setBool,
  printIssues, printTopFiles, printGate, printWarnings, printReport, main
};

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error('[cycscan] 运行异常: ' + (e && e.message));
    process.exit(1);
  }
}
