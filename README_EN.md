**中文** · [README.md](./README.md)

> [!WARNING]
> **⚠️ This tool has been merged into the [doctors](https://github.com/huanweide/doctors) monorepo and is no longer maintained here.**
>
> The source now lives at [`doctors/packages/cycscan/`](https://github.com/huanweide/doctors/tree/main/packages/cycscan). Inside doctors it runs as the `doctors cyc` subcommand (or `node packages/cycscan/index.js`). This repository no longer accepts changes — please use <https://github.com/huanweide/doctors>.

<!-- badges -->
[![License](https://img.shields.io/github/license/huanweide/cycscan)](LICENSE)
[![Stars](https://img.shields.io/github/stars/huanweide/cycscan)](https://github.com/huanweide/cycscan/stargazers)
[![zero-dep checkup CLI](https://img.shields.io/badge/zero--dep%20checkup%20CLI-18%20tools-22c55e)](https://github.com/huanweide/family-showcase)
<!-- /badges -->

**🔧 Part of the [huanweide zero-dependency CLI family](https://github.com/huanweide/family-showcase) (18 single-file tools). Use it standalone, as a subcommand inside the [doctors](https://github.com/huanweide/doctors) monorepo, or run everything together via [enghealth](https://github.com/huanweide/enghealth).**

# cycscan

> Zero-dependency, single-file Node CLI · structural complexity static scanner

Scans JS / TS / JSX / TSX / Vue / Svelte source for the two most frequent "structural smells" — **zero config, offline, single file, cross-platform** — and drops straight into pre-commit / CI.

## Who should use this

- Teams that want a fast, dependency-free structural-complexity gate in CI.
- Projects that can't easily adopt a Rust toolchain (oxlint) or a configured ESLint + typescript-eslint setup.
- Anyone who wants deterministic, reproducible complexity numbers in under 30 seconds on any CI.

## Who should not use this

- Projects that are not JS/TS/Vue/Svelte.
- If you want full AST-based analysis with deep language semantics — a configured ESLint/typescript-eslint gives finer granularity.
- Note: this repo is deprecated — prefer `doctors cyc` for new setups.

## Install and run

This project is **not published on npm** (`npm view cycscan` returns 404), so `npx cycscan` is currently a dead command. Use the source directly:

```bash
git clone https://github.com/huanweide/cycscan.git
node cycscan/index.js --root ./src --max-complexity 20 --fail-on-high
```

Or copy `index.js` into your own repo (it only depends on Node built-ins, no `npm install`).

> Requires Node 18+.

## Why you need it

Cyclomatic complexity and over-long functions are among the most central **code-health metrics** in tools like SonarQube. But:

- `oxlint` needs a Rust toolchain; `ESLint` + `typescript-eslint` need a pile of config.
- `escomplex` / `complexity-report` are stuck at `2.0.0-alpha` and need `npm install` to pull an AST parsing chain.
- **cycscan** is a pure-text-layer, zero-dependency single file with deterministic static scanning — runs out of the box with no config, results in 30 seconds on any CI.

## Detection rules

| Rule | Severity | Default threshold | Signal |
| --- | --- | --- | --- |
| `complex-function` (high cyclomatic complexity) | high | complexity > `10` | spaghetti function, branching explosion |
| `long-function` (over-long function) | medium | length > `60` lines | god function, poor readability |

Cyclomatic complexity algorithm (McCabe approximation): base 1 + branch decision points (`if` / `for` / `while` / `do` / `switch` / `catch` / `case` / `&&` / `||` / `?`). **Inner blocks of nested functions don't count toward the outer function**, so a grandparent function isn't inflated by its grandchildren's branches.

## Usage

```
cycscan [scan] [--root <dir>] [--json]
        [--complexity-threshold <n>] [--lines-threshold <n>]
        [--max-high <n>] [--max-medium <n>] [--max-issues <n>]
        [--max-complexity <n>] [--max-lines <n>]
        [--fail-on-high] [--fail-on-issues]
```

**Detection thresholds** (scan sensitivity, integers `>= 1`):

- `--complexity-threshold <n>`: cyclomatic-complexity alert threshold (default `10`)
- `--lines-threshold <n>`: function-length alert threshold (default `60` lines)

**Gate thresholds** (integers `>= 0`, where `0` is a legal value = forbid any):

- `--max-high / --max-medium / --max-issues <n>`: gate fails if the corresponding count exceeds it
- `--max-complexity <n>`: gate fails if the highest complexity exceeds it (most common in CI)
- `--max-lines <n>`: gate fails if the longest function exceeds it
- `--fail-on-high`: fail on any over-complex function
- `--fail-on-issues`: fail on any warning
- `--json`: machine-readable output

### Exit code contract

| Exit code | State | Meaning |
| --- | --- | --- |
| `0` | `pass` | gate thresholds configured, and all met |
| `2` | `fail` | gate thresholds configured and an item is unmet; **or** a parameter is invalid |
| `3` | `inconclusive` | **no gate threshold configured, or the scan input is empty — conclusion untrustworthy, not a pass** |
| `1` | internal error | only for unexpected exceptions; the gate itself never returns 1 |

> **Why `3` exists**: the worst failure mode for a scanning gate is "scanned 0 files but reported pass" — a green light on CI that never goes out. The decision order is fixed: ① is a threshold configured? → ② is the input trustworthy? → ③ is anything unmet? An empty input makes `--fail-on-issues` also return `3`, because that "warning" is itself a product of the empty scan and proves nothing.
>
> **A wrong parameter = no gate at all**: a threshold missing its value / empty string / trailing junk (`5abc`) / decimal / negative / hex / `Infinity`; `--root` missing its value or swallowing the next flag; any unknown option (including `-x`, or a misspelled `--max-issue`) — all exit `2`, never silently pass.
>
> Special note on `--complexity-threshold`: once it becomes `NaN`, `complexity > NaN` is always false, so **the entire detection silently fails, reports zero issues, and exits 0**. Parameter validation is P0, not polish.

### JSON output

The top level includes `basisComplete` (boolean). `false` means the scan input is untrustworthy, and `healthScore` is then `null` — don't treat it as 0 or 100. `gate` is an object `{ state, configured, reason, failures }`, not a boolean.

## CI integration

```yaml
# .github/workflows/quality.yml
- name: Structural complexity gate
  run: node .github/cycscan/index.js --root src --max-complexity 20 --max-lines 100 --fail-on-high
```

> If you clone this repo into CI, write an explicit `node <path>/index.js` — don't use `npx cycscan` (no such package on npm).
>
> In CI, **pass a gate threshold explicitly**. With no threshold configured the exit code is `3` (inconclusive), which will immediately turn the pipeline red — deliberately: the gate must be defined by the user, the tool shouldn't guess for you.

```bash
# local pre-commit
node cycscan/index.js --root . --max-complexity 20 && echo "complexity OK"
```

## Health score

1 weighted issue per 1k source lines is free; beyond that it deducts by factor `25`, score `0–100`:

- `90+` healthy
- `70–89` basically healthy
- `40–69` structural risk elevated
- `<40` structural risk high

When the scan input is empty the health score is `null` (`verdict: cannot evaluate`) — **it will not hand you a misleading 100**.

## Sample output

```
cycscan · structural complexity scan · root=/project/src
  source files : 42
  total funcs  : 318
  source lines : 8742
  total issues : 5 (weighted 11)
  max complexity : 27
  longest function : 153 lines
  health score : 72 / 100  [basically healthy]
  gate: pass  [state=pass configured=true]
    reason: all configured gate items met.
```

## In the same family

cycscan is the "structural complexity" member of the huanweide zero-dependency CLI family, complementary to:

- `devdoctor` — dependency checkup (bloat / licenses / circular deps / secrets)
- `testlite` — test-hygiene checkup
- `debtlens` — tech-debt density (TODO/FIXME etc.)
- `a11ydoctor` — Web accessibility static scan
- `awaitscan` — async performance anti-patterns (serial await / nested loops)

## Design rules

- Pure local, zero-dependency, offline, single file, cross-platform (Windows / POSIX paths).
- Character-by-character tokenizer strips comments/strings (newlines preserved) — prevents example/doc false signals and avoids dogfood self-pollution.
- Bracket-balance locates function bodies + nested-function exclusion ("surface" philosophy).
- `node_modules` / `dist` / `build` etc. are auto-skipped; single files >5MB skipped to avoid OOM.
- **Three-state gate, never a fake green**: no threshold configured or empty input always returns `3` and prints `state=inconclusive`, never silent.
- **The health score is a dangerous metric**: when it can't scan anything it returns `null`, not 100.
- **Gate failure messages must echo the real threshold** — printing `undefined` says nothing.

## Develop and test

Zero dependencies, run directly with `node`, no `npm install`:

```bash
node test/unit.test.js     # unit tests: scan logic / three-state judgment / param parsing / self gate
node test/smoke-cli.js     # spawn-level smoke: really spawns a process to pin the exit-code contract
npm test                   # equivalent to running the two above in order
```

The two test layers are deliberately separated: unit tests only cover exported pure functions and **never touch `process.exitCode`**; the exit-code contract can only be verified by `smoke-cli.js` using `spawnSync` to really spawn a process. You can change an exit code and still have all unit tests green — only the smoke test catches it.

## License

MIT

---

## Author

Maintained by **huanweide** · [GitHub](https://github.com/huanweide)

## Portability · zero-dependency promise

- Zero runtime dependencies: uses only one Node built-in module, no `npm install`.
- Single file: the whole tool is one `index.js`, copy it into any repo and it works.
- Offline / cross-platform: Node 18+ is enough, no network, no OS preference.
- One command: `node index.js --root ./src` (see Usage above).

← [Back to the zero-dependency CLI family overview](https://github.com/huanweide/family-showcase)
