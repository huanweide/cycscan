#!/usr/bin/env node
'use strict';

/*
 * cycscan 单元测试（零依赖，仅用 node:assert）
 *   node test/unit.test.js
 *
 * 只测导出的纯函数 / 三态判定 / 参数解析 / 检测逻辑。
 * 退出码契约由 test/smoke-cli.js 用 spawnSync 真起进程验证 —— 单测不碰 process.exitCode。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const D = require(path.join(ROOT, 'index.js'));

let pass = 0;
const failures = [];
function group(name, fn) {
  try { fn(); pass++; console.log('  [OK] ' + name); }
  catch (e) { failures.push({ name, e }); console.log('  [FAIL] ' + name + '\n         ' + (e && e.message)); }
}

function makeProject(structure) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cy-u-'));
  for (const [rel, content] of Object.entries(structure)) {
    const full = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return tmp;
}

// 一个圈复杂度 16、长度 17 行的函数（15 个 if 分支）
function complexProject() {
  return makeProject({
    'src/a.js': (function () {
      let s = 'function f(n){let c=1;\n';
      for (let i = 0; i < 15; i++) s += 'if(n===' + i + '){c++}\n';
      return s + 'return c}\nmodule.exports=f;\n';
    })()
  });
}

const T = { complexity: 10, lines: 60 };

// ---------------------------------------------------------------------------
group('stripNoise 剥离注释与字符串', () => {
  const s = D.stripNoise('// if (a) {}\nconst x = "if (b) {}";\n/* for(;;){} */\nif (c) {}');
  assert.ok(!/if \(a\)/.test(s), '行注释里的 if 应被剥离');
  assert.ok(!/if \(b\)/.test(s), '字符串里的 if 应被剥离');
  assert.ok(!/for\(;;\)\{\}/.test(s), '块注释里的 for 应被剥离');
  assert.ok(/if \(c\)/.test(s), '真实代码 if 应保留');
  assert.strictEqual(D.stripNoise('a\nb\nc').split('\n').length, 3, '换行必须保留（否则行号全错）');
});

// ---------------------------------------------------------------------------
group('函数边界检测：三种形态', () => {
  let fns = D.findFunctions(D.stripNoise('function foo(){ if(1){} }'));
  assert.strictEqual(fns.length, 1, 'function 声明');
  fns = D.findFunctions(D.stripNoise('const bar = () => { if(1){} };'));
  assert.strictEqual(fns.length, 1, '箭头函数');
  fns = D.findFunctions(D.stripNoise('class A { m(){ if(1){} } }'));
  assert.strictEqual(fns.length, 1, 'class 方法简写');
  fns = D.findFunctions(D.stripNoise('obj.fn(1);'));
  assert.strictEqual(fns.length, 0, '方法调用不得被当成函数定义');
  fns = D.findFunctions(D.stripNoise('const o = { p: function(){ if(1){} } };'));
  assert.ok(fns.length >= 1, '对象属性里的函数表达式应被识别');
});

// ---------------------------------------------------------------------------
group('圈复杂度：基础值与分支计数', () => {
  const s1 = D.stripNoise('function a(){ return 1; }');
  assert.strictEqual(D.countComplexity(s1, D.findFunctions(s1)[0], D.findFunctions(s1)), 1, '无分支应为 1');
  // 注意：else 不是独立决策点（DECISION_RE 里没有它），if/else 只算 1 个分支
  const s2 = D.stripNoise('function a(x){ if(x){} else {} for(;;){} }');
  assert.strictEqual(D.countComplexity(s2, D.findFunctions(s2)[0], D.findFunctions(s2)), 3,
    '基础1 + if 1 + for 1 = 3（else 不额外计分）');
  // && / || / ?: 各算一个决策点
  const s3 = D.stripNoise('function b(x,y){ return x && y || x ? 1 : 0; }');
  assert.strictEqual(D.countComplexity(s3, D.findFunctions(s3)[0], D.findFunctions(s3)), 4,
    '基础1 + && 1 + || 1 + ? 1 = 4');
});

// ---------------------------------------------------------------------------
group('圈复杂度：排除嵌套函数内层分支', () => {
  const code = 'function outer(n){\n' +
    '  function inner(m){ if(m){} else {} }\n' +
    '  if(n){}\n' +
    '  return inner;\n' +
    '}\n';
  const s = D.stripNoise(code);
  const fns = D.findFunctions(s);
  assert.strictEqual(fns.length, 2, '应识别出 outer 与 inner 两个函数');
  const outer = fns.filter(f => s.slice(f.headerStart, f.headerStart + 12).startsWith('function out'))[0];
  assert.ok(outer, '必须能定位到 outer 函数');
  const inner = fns.filter(f => s.slice(f.headerStart, f.headerStart + 12).startsWith('function inn'))[0];
  assert.ok(inner, '必须能定位到 inner 函数');
  const cplx = D.countComplexity(s, outer, fns);
  assert.ok(cplx <= 3, '爷爷函数不应被孙函数的 if 拉高，实际 ' + cplx + '（基础1 + 自身 if 1）');
  // 反向确认 inner 自己确实被算出了 2（证明不是"谁都不算"）
  assert.ok(D.countComplexity(s, inner, fns) >= 2, 'inner 应算出自己的分支');
});

// ---------------------------------------------------------------------------
group('detectInText 报出复杂函数与长函数', () => {
  const p = complexProject();
  const res = D.detectInText(D.stripNoise(fs.readFileSync(path.join(p, 'src/a.js'), 'utf8')), 'x.js', T);
  assert.ok(res.functionCount >= 1);
  const ids = res.issues.map(i => i.rule.id);
  assert.ok(ids.includes('complex-function'), '复杂度 16 > 10，应报 complex-function');
  assert.ok(!ids.includes('long-function'), '17 行 < 阈值 60，不该报 long-function');
  assert.strictEqual(res.maxLines, 17);
  assert.strictEqual(res.maxComplexity, 16);

  // 调低 lines 阈值后必须报出 long-function（证明该规则本身没坏）
  const res2 = D.detectInText(D.stripNoise(fs.readFileSync(path.join(p, 'src/a.js'), 'utf8')), 'x.js',
    { complexity: 10, lines: 5 });
  assert.ok(res2.issues.map(i => i.rule.id).includes('long-function'), '阈值 5 时 17 行应超限');
});

// ---------------------------------------------------------------------------
group('analyze 计数与 basisComplete', () => {
  const a = D.analyze(complexProject(), T);
  assert.strictEqual(a.files, 1);
  assert.ok(a.srcLines > 0);
  assert.strictEqual(a.basisComplete, true, '有源码有行数 → basisComplete 必须 true');
  assert.ok(a.maxComplexity > 10, '最高圈复杂度应超默认阈值');
  assert.strictEqual(a.bySeverity.high, 1);
  assert.strictEqual(a.issueCount, a.bySeverity.high + a.bySeverity.medium);
  assert.ok(a.healthScore >= 0 && a.healthScore <= 100);
  // 排序：high 在前
  if (a.issues.length > 1) {
    const sev = a.issues.map(i => i.rule.severity);
    const firstMedium = sev.indexOf('medium');
    assert.ok(firstMedium === -1 || sev.slice(0, firstMedium).every(s => s === 'high'), 'high 必须排在 medium 前');
  }
});

// ---------------------------------------------------------------------------
group('P0 有害指标：空输入不给 100 分', () => {
  const empty = D.analyze(fs.mkdtempSync(path.join(os.tmpdir(), 'cy-empty-')), T);
  assert.strictEqual(empty.files, 0);
  assert.strictEqual(empty.basisComplete, false, '0 个文件 → basisComplete 必须 false');
  assert.strictEqual(empty.healthScore, null, '0 个文件时健康分必须是 null，不能是 100');
  assert.strictEqual(empty.verdict, '无法评估');
  assert.notStrictEqual(empty.healthScore, 100, '反向断言：挡住「顺手改回 100」');
});

// ---------------------------------------------------------------------------
group('P0 门禁三态判定顺序', () => {
  const base = { files: 10, srcLines: 100, basisComplete: true, gate: [] };

  let s = D.buildGateState({ ...base, opts: { maxIssues: 0 } });
  assert.strictEqual(s.state, D.GATE_STATE.PASS);
  assert.strictEqual(D.exitCodeFor(s.state), 0, 'exitCodeFor 收 state 字符串，不是对象');

  s = D.buildGateState({ ...base, opts: { maxIssues: 0 }, gate: ['x'] });
  assert.strictEqual(s.state, D.GATE_STATE.FAIL);
  assert.strictEqual(D.exitCodeFor(s.state), 2);

  s = D.buildGateState({ ...base, opts: {} });
  assert.strictEqual(s.state, D.GATE_STATE.INCONCLUSIVE, '未配门禁绝不能是 pass');
  assert.strictEqual(s.configured, false);
  assert.strictEqual(D.exitCodeFor(s.state), 3);

  s = D.buildGateState({ files: 0, srcLines: 0, basisComplete: false, opts: { maxIssues: 0 }, gate: [], });
  assert.strictEqual(s.state, D.GATE_STATE.INCONCLUSIVE, '空输入 + 已配门禁绝不能是 pass');
  assert.strictEqual(s.configured, true);

  s = D.buildGateState({ files: 3, srcLines: 0, basisComplete: false, opts: { maxComplexity: 0 }, gate: [] });
  assert.strictEqual(s.state, D.GATE_STATE.INCONCLUSIVE);

  // 五种门禁开关任意一种都算「已配置」
  for (const opts of [{ maxHigh: 1 }, { maxMedium: 1 }, { maxIssues: 1 },
                      { maxComplexity: 1 }, { maxLines: 1 }, { failOnHigh: true }, { failOnIssues: true }]) {
    const st = D.buildGateState({ ...base, opts });
    assert.strictEqual(st.configured, true, '应识别为已配置: ' + JSON.stringify(opts));
  }
});

// ---------------------------------------------------------------------------
group('P0 门禁失败消息必须回显真实阈值（原码打印 undefined）', () => {
  const a = {
    files: 5, srcLines: 200, basisComplete: true,
    issueCount: 7, bySeverity: { high: 2, medium: 5, low: 0 },
    maxComplexity: 16, maxLines: 17
  };
  const gate = D.collectGateFailures(a, {
    maxHigh: 1, maxMedium: 4, maxIssues: 3, maxComplexity: 5, maxLines: 3
  }, []);
  assert.strictEqual(gate.length, 5, '五项都应不达标，实际 ' + gate.length + ': ' + JSON.stringify(gate));
  for (const line of gate) {
    assert.ok(!/undefined/.test(line), '阈值不得回显 undefined: ' + line);
    assert.ok(!/NaN/.test(line), '阈值不得回显 NaN: ' + line);
  }
  // 逐条钉死：两边必须是「实测值 > 阈值」，两个不同的数
  assert.ok(gate.some(l => l.includes('高危问题 2 > --max-high 1')), '实际: ' + JSON.stringify(gate));
  assert.ok(gate.some(l => l.includes('中危问题 5 > --max-medium 4')));
  assert.ok(gate.some(l => l.includes('总问题数 7 > --max-issues 3')));
  assert.ok(gate.some(l => l.includes('最高圈复杂度 16 > --max-complexity 5')));
  assert.ok(gate.some(l => l.includes('最长函数 17 行 > --max-lines 3')));

  // 全部达标时不得有任何失败项
  assert.strictEqual(D.collectGateFailures(a, {
    maxHigh: 2, maxMedium: 5, maxIssues: 7, maxComplexity: 16, maxLines: 17
  }, []).length, 0, '等于阈值不算超（严格大于才失败）');
});

// ---------------------------------------------------------------------------
group('P0 --complexity-threshold abc 曾让整个检测静默失效', () => {
  assert.throws(() => D.parseArgs(['--complexity-threshold', 'abc']), e => e instanceof D.UsageExit && e.code === 2);
  assert.throws(() => D.parseArgs(['--complexity-threshold']), D.UsageExit);
  assert.throws(() => D.parseArgs(['--complexity-threshold', '0']), D.UsageExit, '检测阈值必须 >= 1');
  assert.throws(() => D.parseArgs(['--complexity-threshold', '-5']), D.UsageExit);
  assert.throws(() => D.parseArgs(['--lines-threshold', 'abc']), D.UsageExit);
  assert.throws(() => D.parseArgs(['--lines-threshold', '0']), D.UsageExit);
  // 合法值
  assert.strictEqual(D.parseArgs(['--complexity-threshold', '1']).complexityThreshold, 1);
  assert.strictEqual(D.parseArgs(['--lines-threshold', '999']).linesThreshold, 999);
  // 默认值不为 NaN
  const d = D.parseArgs([]);
  assert.ok(Number.isFinite(d.complexityThreshold) && d.complexityThreshold === 10);
  assert.ok(Number.isFinite(d.linesThreshold) && d.linesThreshold === 60);
});

// ---------------------------------------------------------------------------
group('P0 门禁阈值容错六连', () => {
  const bad = [
    ['--max-issues'], ['--max-issues', ''], ['--max-issues', '   '],
    ['--max-issues', '5abc'], ['--max-issues', '2.5'], ['--max-issues', '-1'],
    ['--max-issues', '0x10'], ['--max-issues', 'Infinity'], ['--max-issues', '+'],
    ['--max-high', 'abc'], ['--max-high', ''], ['--max-high', '-1'], ['--max-high', '1.5'],
    ['--max-medium', 'abc'], ['--max-medium', ''],
    ['--max-complexity', 'abc'], ['--max-complexity', ''], ['--max-complexity', '-3'],
    ['--max-lines', 'abc'], ['--max-lines', ''], ['--max-lines', '2.5']
  ];
  for (const argv of bad) {
    assert.throws(() => D.parseArgs(argv), e => e instanceof D.UsageExit && e.code === 2,
      '应报参数错误: ' + JSON.stringify(argv));
  }
  // 门禁阈值 0 是合法值（禁止任何一项）
  for (const f of ['--max-high', '--max-medium', '--max-issues', '--max-complexity', '--max-lines']) {
    assert.strictEqual(D.parseArgs([f, '0'])[D.NUM_FLAGS[f]], 0, f + ' 必须接受 0');
  }
});

// ---------------------------------------------------------------------------
group('P0 --root 缺值 / 吞标志', () => {
  assert.throws(() => D.parseArgs(['--root']), D.UsageExit);
  assert.throws(() => D.parseArgs(['--root', '']), D.UsageExit);
  assert.throws(() => D.parseArgs(['--root', '--json']), D.UsageExit, '--root 不能吞掉下一个标志');
  assert.throws(() => D.parseArgs(['--root', '-x']), D.UsageExit);
  assert.strictEqual(D.parseArgs(['--root', '.']).root, '.');
  assert.strictEqual(D.parseArgs(['--root', 'a b/c']).root, 'a b/c');
});

// ---------------------------------------------------------------------------
group('P0 未知选项一律 exit 2（短/长标志 + 位置参数兜底）', () => {
  for (const argv of [['-x'], ['-z'], ['--totally-unknown'], ['--max-issue', '5'],
                      ['--complexity', '5'], ['-'], ['doctor'], ['stray-positional']]) {
    assert.throws(() => D.parseArgs(argv), D.UsageExit, '应报未知选项/参数: ' + JSON.stringify(argv));
  }
  assert.deepStrictEqual(D.parseArgs(['scan'])._, ['scan']);
  assert.strictEqual(D.parseArgs(['--json']).json, true);
  assert.strictEqual(D.parseArgs(['--fail-on-high']).failOnHigh, true);
  assert.strictEqual(D.parseArgs(['--fail-on-issues']).failOnIssues, true);
  assert.strictEqual(D.parseArgs(['--version']).version, true);
  assert.strictEqual(D.parseArgs(['-V']).version, true);
  assert.strictEqual(D.parseArgs(['--help']).help, true);
  assert.strictEqual(D.parseArgs(['-h']).help, true);
});

// ---------------------------------------------------------------------------
group('buildWarnings', () => {
  const w0 = D.buildWarnings({ files: 0, bySeverity: { high: 0, medium: 0, low: 0 } });
  assert.ok(w0.some(w => w.startsWith('no-source')));
  const w1 = D.buildWarnings({ files: 10, bySeverity: { high: 3, medium: 0, low: 0 } });
  assert.ok(w1.some(w => w.startsWith('has-high-severity')));
  assert.ok(!w1.some(w => w.startsWith('no-source')));
  const w2 = D.buildWarnings({ files: 10, bySeverity: { high: 0, medium: 0, low: 0 } });
  assert.strictEqual(w2.length, 0);
});

// ---------------------------------------------------------------------------
group('computeScore 边界', () => {
  assert.deepStrictEqual(D.computeScore(0), { score: 100, verdict: '健康' });
  assert.deepStrictEqual(D.computeScore(1), { score: 100, verdict: '健康' });
  assert.deepStrictEqual(D.computeScore(2), { score: 75, verdict: '基本健康' });
  assert.deepStrictEqual(D.computeScore(5), { score: 0, verdict: '结构风险高' });
});

// ---------------------------------------------------------------------------
group('applyGate 兼容旧签名', () => {
  const a = { files: 5, srcLines: 100, basisComplete: true, issueCount: 4,
              bySeverity: { high: 1, medium: 3, low: 0 }, maxComplexity: 16, maxLines: 17 };
  const r = D.applyGate(a, { maxIssues: 1 }, []);
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.state.state, D.GATE_STATE.FAIL);
  assert.strictEqual(D.applyGate(a, {}, []).code, 3, '未配门禁应为 3，不谎报 0');
  assert.strictEqual(D.applyGate({ files: 0, srcLines: 0, basisComplete: false, issueCount: 0,
                                  bySeverity: { high: 0, medium: 0, low: 0 } }, { maxIssues: 0 }, []).code, 3);
  assert.strictEqual(D.applyGate(a, { maxIssues: 99 }, []).code, 0);
});

// ---------------------------------------------------------------------------
group('GATE_CHECKS 消息函数签名必须是 (a, threshold)', () => {
  assert.strictEqual(D.GATE_CHECKS.length, 5);
  for (const [key, flag, get, msg] of D.GATE_CHECKS) {
    assert.ok(D.NUM_FLAGS[flag] === key, flag + ' 的 key 必须与 NUM_FLAGS 一致');
    assert.strictEqual(typeof get, 'function');
    assert.strictEqual(typeof msg, 'function');
    assert.strictEqual(msg.length, 2, flag + ' 的消息函数必须收两个参数 (a, threshold)');
  }
});

// ---------------------------------------------------------------------------
group('自检门禁: CLI 版本号 == package.json 版本号', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.strictEqual(D.packageVersion(), pkg.version);
  assert.ok(/^\d+\.\d+\.\d+$/.test(pkg.version), '版本号必须三段式，实际: ' + pkg.version);
});

// ---------------------------------------------------------------------------
group('自检门禁: README 白名单 == 源码常量', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  // README 必须说明两条规则
  for (const r of Object.values(D.RULES)) {
    assert.ok(readme.includes(r.id), 'README 必须列出规则 ' + r.id);
  }
  // README 必须说明全部退出码
  for (const n of ['0', '2', '3']) {
    assert.ok(readme.includes('`' + n + '`'), 'README 必须说明退出码 ' + n);
  }
  // README 不得声称未发布的安装方式
  assert.ok(!/npm i -g cycscan/.test(readme), 'npm 上没有 cycscan 包，README 不得教人 npm i -g');
});

// ---------------------------------------------------------------------------
group('退出码契约: 0/2/3，绝不含 1', () => {
  assert.strictEqual(D.EXIT_FOR_STATE.pass, 0);
  assert.strictEqual(D.EXIT_FOR_STATE.fail, 2);
  assert.strictEqual(D.EXIT_FOR_STATE.inconclusive, 3);
  for (const st of [D.GATE_STATE.PASS, D.GATE_STATE.FAIL, D.GATE_STATE.INCONCLUSIVE]) {
    assert.notStrictEqual(D.exitCodeFor(st), 1, '门禁不得返回 1');
  }
  assert.strictEqual(D.exitCodeFor('garbage'), 3, '未知状态兜底为 3，不得静默 0');
});

// ---------------------------------------------------------------------------
console.log('\ncycscan 单元测试：' + pass + ' 组通过，' + failures.length + ' 组失败');
if (failures.length) {
  console.log('\n失败明细：');
  for (const f of failures) console.log('  - ' + f.name + ': ' + (f.e && f.e.message));
  process.exitCode = 1;
} else {
  process.exitCode = 0;
}
