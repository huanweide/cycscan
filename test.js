#!/usr/bin/env node
'use strict';

/*
 * cycscan 自包含单测（零依赖，仅用 node:assert + node:child_process）
 * 运行：node test.js   —— 全绿 exit 0，任一失败 exit 1
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const D = require('./index.js');
const CLI = path.join(__dirname, 'index.js');
const TH = { complexity: 10, lines: 60 };

let pass = 0;
function ok(name) { pass++; console.log('  [OK] ' + name); }

function detect(code) {
  return D.detectInText(D.stripNoise(code), 'sample.js', TH).issues;
}
function countByRule(issues, id) { return issues.filter(i => i.rule.id === id).length; }

function makeProject(structure) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-'));
  Object.keys(structure).forEach(rel => {
    const full = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, structure[rel]);
  });
  return tmp;
}

// 1. C1 圈复杂度过高（命中） ------------------------------------------------
(function checkC1Hit() {
  const code = [
    'function big(x) {',
    '  if (a) {} else if (b) {} else if (c) {} else if (d) {} else if (e) {}',
    '  for (let i=0;i<10;i++){ if (p) {} }',
    '  while (q) { if (r) {} }',
    '  switch (s) { case 1: break; case 2: break; default: break; }',
    '  const y = cond ? 1 : 2;',
    '  if (t || u) {}',
    '  if (v && w) {}',
    '  return 0;',
    '}'
  ].join('\n');
  const issues = detect(code);
  assert.strictEqual(countByRule(issues, 'complex-function'), 1, '应检出 1 个高复杂度函数');
  assert.strictEqual(countByRule(issues, 'long-function'), 0);
  ok('C1 圈复杂度过高命中');
})();

// 2. C1 简单函数不误报 ------------------------------------------------------
(function checkC1Simple() {
  const code = 'function simple(a, b) {\n  if (a > b) return a;\n  return b;\n}';
  const issues = detect(code);
  assert.strictEqual(countByRule(issues, 'complex-function'), 0, '简单函数不应误报');
  ok('C1 简单函数不误报');
})();

// 3. C2 超长函数（命中） ----------------------------------------------------
(function checkC2Long() {
  const lines = ['function longone() {'];
  for (let i = 0; i < 65; i++) lines.push('  const v' + i + ' = ' + i + ';');
  lines.push('  return v0;');
  lines.push('}');
  const issues = detect(lines.join('\n'));
  assert.strictEqual(countByRule(issues, 'long-function'), 1, '超长函数应命中');
  ok('C2 超长函数命中');
})();

// 4. C2 短函数不误报 --------------------------------------------------------
(function checkC2Short() {
  const code = 'function short() {\n  return 1;\n}';
  const issues = detect(code);
  assert.strictEqual(countByRule(issues, 'long-function'), 0, '短函数不应误报');
  ok('C2 短函数不误报');
})();

// 5. 嵌套函数排除：外层不被内层分支虚高 ------------------------------------
(function checkNestedExclusion() {
  const code = [
    'function outer() {',
    '  if (a) {',
    '    function inner() {',
    '      if (b) {} if (c) {} if (d) {} if (e) {} if (f) {} if (g) {} if (h) {}',
    '    }',
    '    return inner;',
    '  }',
    '  return 0;',
    '}'
  ].join('\n');
  const s = D.stripNoise(code);
  const fns = D.findFunctions(s);
  const outer = fns.find(f => s.startsWith('function outer', f.headerStart));
  const inner = fns.find(f => s.startsWith('function inner', f.headerStart));
  assert.ok(outer, '应找到 outer');
  assert.ok(inner, '应找到 inner（嵌套函数也被识别）');
  assert.strictEqual(D.countComplexity(s, outer, fns), 2, 'outer 自身仅 if(a) + 基础 = 2，内层 7 个 if 不计入');
  assert.strictEqual(D.countComplexity(s, inner, fns), 8, 'inner 自身 7 个 if + 基础 = 8');
  assert.strictEqual(detect(code).length, 0, '两者均 < 阈值，不应报警');
  ok('嵌套函数排除（外层复杂度不被内层虚高）');
})();

// 6. 字符串 / 注释伪信号（不命中） ----------------------------------------
(function checkNoise() {
  const code = [
    'const s = "if (x) { for (let i=0;i<10;i++){ while(q){} } }";',
    '// if (a) { for (;;) {} } while (b) {}',
    'function f(){ return 1; }'
  ].join('\n');
  const issues = detect(code);
  assert.strictEqual(issues.length, 0, '字符串与注释内的伪分支应被剥离');
  ok('字符串/注释内伪信号剥离');
})();

// 7. 箭头函数（块体）高复杂度命中 ------------------------------------------
(function checkArrowBlock() {
  const code = [
    'const heavy = (x) => {',
    '  if (a) {} else if (b) {} else if (c) {} else if (d) {} else if (e) {} else if (f) {} else if (g) {}',
    '  for (let i=0;i<2;i++){ if (p) {} }',
    '  while (q) { if (r) {} }',
    '  switch (s) { case 1: break; case 2: break; case 3: break; }',
    '  if (t || u) {}',
    '  return 0;',
    '};'
  ].join('\n');
  const issues = detect(code);
  assert.strictEqual(countByRule(issues, 'complex-function'), 1, '箭头块体高复杂度应命中');
  ok('箭头函数（块体）高复杂度命中');
})();

// 8. 方法简写检测 + 控制结构不误判为函数 -----------------------------------
(function checkMethods() {
  // 仅控制结构，无函数 → 0 个函数
  const ctrl = 'if (x) { for (let i=0;i<10;i++){ foo(); } }';
  assert.strictEqual(D.findFunctions(D.stripNoise(ctrl)).length, 0, 'if/for 控制结构不应被当函数');

  // class 方法应被识别为函数，且简单方法不报警
  const cls = 'class Foo {\n  bar(x) {\n    if (a) { return 1; }\n    return 2;\n  }\n}';
  const fns = D.findFunctions(D.stripNoise(cls));
  assert.strictEqual(fns.length, 1, 'class 方法应被识别为 1 个函数');
  assert.strictEqual(detect(cls).length, 0, '简单方法不报警');
  ok('方法简写检测 + 控制结构不误判为函数');
})();

// 9. computeScore 边界 -----------------------------------------------------
(function checkScore() {
  assert.deepStrictEqual(D.computeScore(0), { score: 100, verdict: '健康' });
  assert.deepStrictEqual(D.computeScore(1), { score: 100, verdict: '健康' });
  assert.deepStrictEqual(D.computeScore(2), { score: 75, verdict: '基本健康' });
  assert.deepStrictEqual(D.computeScore(5), { score: 0, verdict: '结构风险高' });
  ok('computeScore 边界（0/等于FREE/中间/归零）正确');
})();

// 10. applyGate 阈值校验 ---------------------------------------------------
(function checkGate() {
  const a = { bySeverity: { high: 3, medium: 0, low: 0 }, issueCount: 3, maxComplexity: 25, maxLines: 200 };
  const bad = D.applyGate(a, { maxHigh: NaN }, []);
  assert.strictEqual(bad.code, 2);
  assert.strictEqual(bad.gate, null);

  const g1 = D.applyGate(a, { maxHigh: 2 }, []);
  assert.strictEqual(g1.code, 2);
  assert.ok(g1.gate.some(x => x.includes('max-high')));

  const g2 = D.applyGate(a, { maxComplexity: 20 }, []);
  assert.strictEqual(g2.code, 2);
  assert.ok(g2.gate.some(x => x.includes('max-complexity')));

  const g3 = D.applyGate(a, { maxLines: 100 }, []);
  assert.strictEqual(g3.code, 2);
  assert.ok(g3.gate.some(x => x.includes('max-lines')));

  const g4 = D.applyGate(a, { failOnHigh: true }, []);
  assert.strictEqual(g4.code, 2);

  const g5 = D.applyGate({ bySeverity: { high: 0, medium: 0, low: 0 }, issueCount: 0, maxComplexity: 5, maxLines: 10 }, { maxHigh: 5 }, []);
  assert.strictEqual(g5.code, 0);
  ok('applyGate 阈值非法 exit2 / maxHigh / maxComplexity / maxLines / failOnHigh / 通过 正确');
})();

// 11. CLI 端到端 -----------------------------------------------------------
(function checkCLI() {
  const clean = makeProject({
    'src/a.js': 'function f(a,b){ if(a>b) return a; return b; }\nmodule.exports=f;\n',
    'test/a.test.js': "const assert=require('assert');\ntest('x',()=>assert.ok(true));\n"
  });
  let s0 = 0;
  try { execFileSync(process.execPath, [CLI, '--root', clean], { stdio: 'pipe' }); }
  catch (e) { s0 = e.status; }
  assert.strictEqual(s0, 0, '零问题项目应 exit 0');

  const dirty = makeProject({
    'src/a.js': [
      'function big(x) {',
      '  if (a) {} else if (b) {} else if (c) {} else if (d) {} else if (e) {}',
      '  for (let i=0;i<10;i++){ if (p) {} }',
      '  while (q) { if (r) {} }',
      '  switch (s) { case 1: break; case 2: break; }',
      '  if (t || u) {}',
      '  return 0;',
      '}'
    ].join('\n')
  });
  let s2 = -1;
  try { execFileSync(process.execPath, [CLI, '--root', dirty, '--fail-on-high'], { stdio: 'pipe' }); }
  catch (e) { s2 = e.status; }
  assert.strictEqual(s2, 2, '有高危复杂度 + --fail-on-high 应 exit 2');

  let sBad = -1;
  try { execFileSync(process.execPath, [CLI, '--root', '/no/such/dir/xyz'], { stdio: 'pipe' }); }
  catch (e) { sBad = e.status; }
  assert.strictEqual(sBad, 2, '无效 root 应 exit 2');

  let sNa = -1;
  try { execFileSync(process.execPath, [CLI, '--root', dirty, '--max-complexity', 'abc'], { stdio: 'pipe' }); }
  catch (e) { sNa = e.status; }
  assert.strictEqual(sNa, 2, '--max-complexity 非整数应 exit 2');

  let sMl = -1;
  const longProj = makeProject({ 'src/b.js': (function () {
    const lines = ['function longone() {'];
    for (let i = 0; i < 15; i++) lines.push('  const v' + i + ' = ' + i + ';');
    lines.push('  return v0;');
    lines.push('}');
    return lines.join('\n');
  })() });
  try { execFileSync(process.execPath, [CLI, '--root', longProj, '--max-lines', '10'], { stdio: 'pipe' }); }
  catch (e) { sMl = e.status; }
  assert.strictEqual(sMl, 2, '--max-lines 触发应 exit 2');

  ok('CLI 端到端（零问题/门禁/无效root/非整数阈值/max-lines）退出码正确');
})();

// 12. --version ------------------------------------------------------------
(function checkVersion() {
  let out = '';
  let s = 0;
  try { out = execFileSync(process.execPath, [CLI, '--version'], { stdio: 'pipe' }).toString(); }
  catch (e) { s = e.status; out = (e.stdout || '').toString(); }
  assert.strictEqual(s, 0, '--version 应 exit 0');
  assert.ok(/cycscan\s+\d+\.\d+\.\d+/.test(out.trim()), '应输出版本号，实际: ' + out.trim());
  ok('CLI --version 输出版本号并 exit 0');
})();

// 13. --json 输出合法 ------------------------------------------------------
(function checkJson() {
  const clean = makeProject({ 'src/a.js': 'function f(a,b){ if(a>b) return a; return b; }\n' });
  let out = '';
  try { out = execFileSync(process.execPath, [CLI, '--root', clean, '--json'], { stdio: 'pipe' }).toString(); }
  catch (e) { out = (e.stdout || '').toString(); }
  let parsed = null;
  assert.doesNotThrow(() => { parsed = JSON.parse(out); }, '应输出合法 JSON');
  assert.ok(parsed && typeof parsed.healthScore === 'number', 'JSON 应含 healthScore');
  assert.ok(parsed && Array.isArray(parsed.issues), 'JSON 应含 issues 数组');
  assert.strictEqual(parsed.healthScore, 100, '干净项目健康分应为 100');
  ok('--json 输出合法且含关键字段');
})();

// 14. findFunctions 综合计数 ----------------------------------------------
(function checkFindCount() {
  const code = [
    'function decl() { if (a) return 1; return 0; }',
    'const arrow = (x) => { if (x) return 1; return 0; };',
    'class C { method(y) { if (y) return 1; return 0; } }'
  ].join('\n');
  const fns = D.findFunctions(D.stripNoise(code));
  assert.strictEqual(fns.length, 3, '应识别 function 声明 + 箭头 + 方法简写 共 3 个函数');
  ok('findFunctions 综合计数（声明/箭头/方法）正确');
})();

console.log('\ncycscan 单测：' + pass + ' 项全绿');
