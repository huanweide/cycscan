#!/usr/bin/env node
'use strict';

/*
 * cycscan spawn 级 CLI 冒烟测试
 *   node test/smoke-cli.js
 *
 * 为什么必须有这个文件：单测只测导出的函数，根本不碰 process.exitCode ——
 * 改退出码时单测可以全绿而门禁已失效。本文件用 spawnSync 真起进程，
 * 逐条钉死「什么输入 → 什么退出码」。
 *
 * 反向覆盖：假绿灯四变体 + 有害指标 + 门禁参数写错=门禁不存在
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'index.js');

let pass = 0;
const failures = [];

function run(args) {
  const r = spawnSync(process.execPath, [CLI].concat(args), {
    encoding: 'utf8', cwd: ROOT, maxBuffer: 32 * 1024 * 1024
  });
  if (r.error) throw r.error;
  return { rc: r.status, out: r.stdout || '', err: r.stderr || '' };
}

function expectRc(name, args, wantRc, opts) {
  opts = opts || {};
  try {
    const r = run(args);
    assert.strictEqual(r.rc, wantRc,
      name + '\n  期望 rc=' + wantRc + ' 实际 rc=' + r.rc +
      '\n  stdout: ' + r.out.slice(-400) + '\n  stderr: ' + r.err.slice(-400));
    if (opts.assertOut) opts.assertOut(r.out, r.err);
    pass++;
    console.log('  [OK] ' + name);
  } catch (e) {
    failures.push({ name, e });
    console.log('  [FAIL] ' + name + '\n         ' + (e && e.message));
  }
}

function expectTrue(name, fn) {
  try { fn(); pass++; console.log('  [OK] ' + name); }
  catch (e) { failures.push({ name, e }); console.log('  [FAIL] ' + name + '\n         ' + (e && e.message)); }
}

function makeProject(structure) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cy-s-'));
  for (const [rel, content] of Object.entries(structure)) {
    const full = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return tmp;
}

// 复杂度 16 / 长度 17 行的函数
const DIRTY = makeProject({
  'src/a.js': (function () {
    let s = 'function f(n){let c=1;\n';
    for (let i = 0; i < 15; i++) s += 'if(n===' + i + '){c++}\n';
    return s + 'return c}\nmodule.exports=f;\n';
  })()
});
const CLEAN = makeProject({ 'src/a.js': 'const x=1;\nmodule.exports=x;\n' });
const EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), 'cy-blank-'));

// ---------------------------------------------------------------------------
// 1. 假绿灯变体 A：空输入 + 配了门禁 → 必须 3
// ---------------------------------------------------------------------------
expectRc('A 空输入 + --max-issues 0 → rc=3', ['--root', EMPTY, '--max-issues', '0'], 3);
expectRc('A 空输入 + --max-complexity 0 → rc=3', ['--root', EMPTY, '--max-complexity', '0'], 3);
expectRc('A 空输入 + --max-high 0 → rc=3', ['--root', EMPTY, '--max-high', '0'], 3);
expectRc('A 空输入 + --fail-on-high → rc=3（输入空，不因没命中而通过）', ['--root', EMPTY, '--fail-on-high'], 3);
expectRc('A 空输入 + --fail-on-issues → rc=3（空扫描的警告不足为凭）', ['--root', EMPTY, '--fail-on-issues'], 3);

expectTrue('A 空输入 --json 必须 basisComplete=false 且 healthScore=null', () => {
  const j = JSON.parse(run(['--root', EMPTY, '--json', '--max-issues', '0']).out);
  assert.strictEqual(j.files, 0);
  assert.strictEqual(j.functionCount, 0);
  assert.strictEqual(j.basisComplete, false);
  assert.strictEqual(j.healthScore, null, '不能是 100');
  assert.notStrictEqual(j.healthScore, 100);
  assert.strictEqual(j.verdict, '无法评估');
  assert.strictEqual(j.gate.state, 'inconclusive');
  assert.strictEqual(j.gate.configured, true);
});

// ---------------------------------------------------------------------------
// 2. 假绿灯变体 C：未配门禁 → 必须 3
// ---------------------------------------------------------------------------
expectRc('C 未配任何门禁 + 脏项目 → rc=3', ['--root', DIRTY], 3);
expectRc('C 未配任何门禁 + 干净项目 → rc=3', ['--root', CLEAN], 3);
expectTrue('C 未配门禁时文本不得出现「门禁: 通过」', () => {
  const r = run(['--root', CLEAN]);
  assert.ok(!/门禁: 通过/.test(r.out), '未配门禁绝不能打印通过，实际: ' + r.out);
  assert.ok(/state=inconclusive/.test(r.out));
  assert.ok(/configured=false/.test(r.out));
});

// ---------------------------------------------------------------------------
// 3. 假绿灯变体 D：JSON gate 必须是对象
// ---------------------------------------------------------------------------
expectTrue('D JSON gate 必须是 {state,configured,reason,failures}，不是布尔', () => {
  const j = JSON.parse(run(['--root', DIRTY, '--json', '--max-issues', '0']).out);
  assert.strictEqual(typeof j.gate, 'object');
  assert.notStrictEqual(typeof j.gate, 'boolean');
  assert.strictEqual(j.gate.state, 'fail');
  assert.strictEqual(j.gate.configured, true);
  assert.ok(j.gate.reason && j.gate.reason.length > 0);
  assert.ok(Array.isArray(j.gate.failures));
  assert.ok(Object.prototype.hasOwnProperty.call(j, 'basisComplete'));
});

// ---------------------------------------------------------------------------
// 4. 真实三态 pass / fail
// ---------------------------------------------------------------------------
expectRc('pass：干净项目 + 宽松阈值 → rc=0', ['--root', CLEAN, '--max-issues', '999'], 0);
expectRc('fail：脏项目 + --max-issues 0 → rc=2', ['--root', DIRTY, '--max-issues', '0'], 2);
expectRc('fail：脏项目 + --fail-on-high → rc=2', ['--root', DIRTY, '--fail-on-high'], 2);
expectRc('pass：干净项目 + --fail-on-high → rc=0', ['--root', CLEAN, '--fail-on-high'], 0);
expectRc('pass：阈值恰等于实际值 → rc=0（严格大于才失败）', ['--root', DIRTY, '--max-issues', '1'], 0);
expectTrue('pass 时也必须显式打印「门禁: 通过」+ state=pass', () => {
  const r = run(['--root', CLEAN, '--max-issues', '999']);
  assert.ok(/门禁: 通过/.test(r.out));
  assert.ok(/state=pass/.test(r.out));
});

// ---------------------------------------------------------------------------
// 5. 【本仓最严重缺陷】门禁失败消息回显 undefined / 两边同值
// ---------------------------------------------------------------------------
expectTrue('门禁失败消息必须回显真实阈值，不得出现 undefined', () => {
  const r = run(['--root', DIRTY, '--max-high', '0', '--max-issues', '0',
                  '--max-medium', '0', '--max-complexity', '5', '--max-lines', '3']);
  assert.strictEqual(r.rc, 2);
  const failLines = r.out.split('\n').filter(l => l.includes('[失败]'));
  assert.ok(failLines.length >= 4, '应有 4 条以上失败明细，实际: ' + JSON.stringify(failLines));
  for (const l of failLines) {
    assert.ok(!/undefined/.test(l), '阈值回显了 undefined: ' + l);
    assert.ok(!/NaN/.test(l), '阈值回显了 NaN: ' + l);
  }
  // 逐条钉死「实测值 > 阈值」，两个数必须不同
  // 注意实测值可能带单位（如「17 行」），故捕获到 '--' 前为止
  const m = {};
  for (const l of failLines) {
    const g = /^(.*?)\s(\d+)(?: 行)?\s>\s(--[a-z-]+)\s(\S+)/.exec(l.trim().replace(/^\[失败\]\s*/, ''));
    assert.ok(g, '失败消息格式应含「值 > 阈值」: ' + l);
    m[g[3]] = { actual: g[2], threshold: g[4] };
  }
  assert.strictEqual(m['--max-high'].threshold, '0');
  assert.strictEqual(m['--max-issues'].threshold, '0');
  assert.strictEqual(m['--max-complexity'].threshold, '5');
  assert.strictEqual(m['--max-lines'].threshold, '3');
  // 反向断言：实测值与阈值不得相同（原码 --max-complexity 会打印 16 > 16）
  assert.notStrictEqual(m['--max-complexity'].actual, m['--max-complexity'].threshold,
    '实测值与阈值相同 = 消息等于没说（原码 bug）');
  assert.notStrictEqual(m['--max-lines'].actual, m['--max-lines'].threshold);
});

// ---------------------------------------------------------------------------
// 6. 【本仓第二严重】检测阈值 NaN → 整个检测静默失效
// ---------------------------------------------------------------------------
expectTrue('--complexity-threshold abc 必须报错而不是让检测静默失效', () => {
  const bad = run(['--root', DIRTY, '--complexity-threshold', 'abc']);
  assert.strictEqual(bad.rc, 2, '必须 exit 2');
  assert.ok(bad.err.includes('complexity-threshold'), '错误信息应指明是哪个参数');

  // 对照：同一个项目，阈值合法时必须能检出高危
  const good = JSON.parse(run(['--root', DIRTY, '--json', '--complexity-threshold', '10',
                              '--max-issues', '999']).out);
  assert.ok(good.bySeverity.high >= 1, '合法阈值下应检出高危函数');
  assert.ok(good.maxComplexity > 10);
});
expectTrue('--complexity-threshold 0 / 负数 / 空串 / 小数 一律 rc=2', () => {
  for (const v of ['0', '-1', '', '2.5', '5abc', 'abc', '0x10', 'Infinity']) {
    const r = run(['--root', DIRTY, '--complexity-threshold', v]);
    assert.strictEqual(r.rc, 2, '阈值 ' + JSON.stringify(v) + ' 应 exit 2，实际 ' + r.rc);
  }
  // 检测阈值 0 会让所有函数超限，这是合法且极端的用法
  const zero = JSON.parse(run(['--root', DIRTY, '--json', '--complexity-threshold', '1',
                               '--max-issues', '99999']).out);
  assert.ok(zero.maxComplexity >= 16, '阈值 1 时应检出全部函数');
});
expectTrue('--lines-threshold 非法同样 rc=2', () => {
  for (const v of ['0', 'abc', '', '-3', '1.5']) {
    assert.strictEqual(run(['--root', DIRTY, '--lines-threshold', v]).rc, 2,
      '阈值 ' + JSON.stringify(v) + ' 应 exit 2');
  }
});

// ---------------------------------------------------------------------------
// 7. 门禁参数完全失效（变体 B）
// ---------------------------------------------------------------------------
const badArgs = [
  ['--max-issues'], ['--max-issues', ''], ['--max-issues', '  '],
  ['--max-issues', '5abc'], ['--max-issues', '2.5'], ['--max-issues', '-1'],
  ['--max-issues', '0x10'], ['--max-issues', 'Infinity'], ['--max-issues', '+'],
  ['--max-high', 'abc'], ['--max-high', ''], ['--max-high', '-1'], ['--max-high', '1.5'],
  ['--max-medium', 'abc'], ['--max-medium', ''], ['--max-medium', '-2'],
  ['--max-complexity', 'abc'], ['--max-complexity', ''], ['--max-complexity', '-3'],
  ['--max-lines', 'abc'], ['--max-lines', ''], ['--max-lines', '2.5'],
  ['--complexity-threshold'], ['--complexity-threshold', ''], ['--complexity-threshold', 'abc'],
  ['--lines-threshold'], ['--lines-threshold', ''], ['--lines-threshold', 'abc'],
  ['--root'], ['--root', ''], ['--root', '--json'], ['--root', '-x'],
  ['-x'], ['-z'], ['--totally-unknown'], ['--max-issue', '5'], ['--complexity', '5'],
  ['-'], ['doctor'], ['stray-positional']
];
expectTrue('门禁/检测/路径/未知选项共 ' + badArgs.length + ' 组参数错误全部 rc=2', () => {
  const bad = [];
  for (const argv of badArgs) {
    const r = run(['--root', CLEAN].concat(argv));
    if (r.rc !== 2) bad.push(JSON.stringify(argv) + ' → rc=' + r.rc);
  }
  assert.strictEqual(bad.length, 0, '这些参数错误没有被拦住:\n    ' + bad.join('\n    '));
});
expectTrue('参数错误走 stderr 且 stdout 干净（不得半截 JSON）', () => {
  const r = run(['--root', CLEAN, '--json', '--max-issues', '5abc']);
  assert.strictEqual(r.rc, 2);
  assert.ok(r.err.trim().length > 0);
  assert.strictEqual(r.out.trim(), '', '参数错误时 stdout 必须干净，实际: ' + r.out);
});

// ---------------------------------------------------------------------------
// 8. 退出码只允许 0/2/3
// ---------------------------------------------------------------------------
expectTrue('所有场景退出码 ⊆ {0,2,3}，且三态都被覆盖', () => {
  const all = [
    ['--root', CLEAN], ['--root', DIRTY], ['--root', EMPTY],
    ['--root', CLEAN, '--max-issues', '999'], ['--root', DIRTY, '--max-issues', '0'],
    ['--root', EMPTY, '--max-issues', '0'], ['--root', DIRTY, '--fail-on-issues'],
    ['--root', CLEAN, '--max-issues', '5abc'], ['--version'], ['--help'], ['scan']
  ];
  const seen = new Set();
  const bad = [];
  for (const argv of all) {
    const rc = run(argv).rc;
    seen.add(rc);
    if (rc !== 0 && rc !== 2 && rc !== 3) bad.push(JSON.stringify(argv) + ' → rc=' + rc);
  }
  assert.strictEqual(bad.length, 0, '出现非法退出码:\n    ' + bad.join('\n    '));
  assert.ok(seen.has(0) && seen.has(2) && seen.has(3), '三种状态都应被覆盖，实际只见到 ' + [...seen].join(','));
});

// ---------------------------------------------------------------------------
// 9. --version / --help
// ---------------------------------------------------------------------------
expectRc('--version → rc=0', ['--version'], 0, {
  assertOut: (out) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.ok(out.includes('cycscan ' + pkg.version),
      '--version 必须等于 package.json 的 ' + pkg.version + '，实际: ' + out.trim());
  }
});
expectRc('-V → rc=0', ['-V'], 0);
expectRc('--help → rc=0', ['--help'], 0, {
  assertOut: (out) => {
    assert.ok(/退出码契约/.test(out));
    assert.ok(/inconclusive/.test(out));
    assert.ok(/不等于通过/.test(out));
  }
});
expectRc('-h → rc=0', ['-h'], 0);
expectTrue('--help 不得打印「门禁: 通过」', () => {
  assert.ok(!/门禁: 通过/.test(run(['--help']).out));
});

// ---------------------------------------------------------------------------
// 10. root 校验
// ---------------------------------------------------------------------------
expectRc('root 不存在 → rc=2', ['--root', path.join(os.tmpdir(), 'no-such-cy-xyz')], 2);
expectRc('root 是文件 → rc=2', ['--root', CLI], 2);

// ---------------------------------------------------------------------------
// 11. stdout 完整性
// ---------------------------------------------------------------------------
expectTrue('--json 输出完整可解析且以 } 结尾', () => {
  const r = run(['--root', DIRTY, '--json', '--max-issues', '0']);
  assert.ok(r.out.trim().startsWith('{'));
  assert.ok(r.out.trim().endsWith('}'), '被截断了');
  const j = JSON.parse(r.out);
  assert.strictEqual(j.root, path.resolve(DIRTY));
  assert.ok(j.issues.length >= 1);
  assert.ok(typeof j.issues[0].rule === 'object' && j.issues[0].rule.id, 'issue.rule 应是对象含 id');
});
expectTrue('大项目 --json 不被截断（150 文件 × 20 分支）', () => {
  const big = makeProject({});
  for (let i = 0; i < 150; i++) {
    let s = 'function f' + i + '(n){let c=1;\n';
    for (let k = 0; k < 20; k++) s += 'if(n===' + k + '){c++}\n';
    fs.writeFileSync(path.join(big, 'f' + i + '.js'), s + 'return c}\nmodule.exports=f;\n');
  }
  const r = run(['--root', big, '--json', '--max-issues', '1']);
  assert.ok(r.out.trim().endsWith('}'), '大输出被截断了');
  const j = JSON.parse(r.out);
  assert.strictEqual(j.files, 150);
  assert.ok(j.issueCount >= 150);
});

// ---------------------------------------------------------------------------
// 12. 逐条路径钉死退出码
// ---------------------------------------------------------------------------
expectTrue('逐条路径钉死：pass=0 / fail=2 / 未配=3 / 空输入=3 / 参数错=2', () => {
  const cases = [
    [['--root', CLEAN, '--max-issues', '999'], 0, 'pass'],
    [['--root', DIRTY, '--max-issues', '0'], 2, 'fail'],
    [['--root', DIRTY, '--max-issues', '1'], 0, 'pass(阈值=实际)'],
    [['--root', DIRTY], 3, '未配门禁'],
    [['--root', CLEAN], 3, '未配门禁(干净也 3)'],
    [['--root', EMPTY, '--max-issues', '999'], 3, '空输入(阈值极宽松也 3)'],
    [['--root', EMPTY, '--fail-on-issues'], 3, '空输入+fail-on-issues 仍是 3'],
    [['--root', CLEAN, '--max-issues', 'abc'], 2, '参数错'],
    [['--root', DIRTY, '--complexity-threshold', 'abc'], 2, '检测阈值错'],
    [['--version'], 0, '--version'],
    [['--help'], 0, '--help'],
    [['scan', '--root', CLEAN, '--max-issues', '999'], 0, 'scan 子命令']
  ];
  const bad = [];
  for (const [argv, want, label] of cases) {
    const rc = run(argv).rc;
    if (rc !== want) bad.push(label + ': 期望 ' + want + ' 实际 ' + rc);
  }
  assert.strictEqual(bad.length, 0, '退出码契约漂移:\n    ' + bad.join('\n    '));
});

// ---------------------------------------------------------------------------
console.log('\ncycscan spawn 级冒烟：' + pass + ' 项通过，' + failures.length + ' 项失败');
if (failures.length) {
  console.log('\n失败明细：');
  for (const f of failures) console.log('  - ' + f.name + ': ' + (f.e && f.message));
  process.exitCode = 1;
} else {
  process.exitCode = 0;
}
