# S0.1 — Repo bootstrap (pnpm workspace, TS 7, oxlint/oxfmt)

- after: — (first step)
- unlocks: S0.2
- FRs: — (infrastructure)
- references: PLAN §0, §3.1, §3.6, §4, §9.10

## Goal

Create the empty five-package pnpm workspace with the exact toolchain pinned in PLAN §3.1, so that
`install / lint / format:check / typecheck` all run green on a repo containing only placeholders.
No feature code. Every config file below is complete — copy it verbatim.

## Preconditions (run these; red = STOP)

- `node --version` → v22.12 or later
- `git branch --show-current` → `feat/electron`
- `ls docs/PLAN.md` → exists

## Tasks (numbered, imperative, zero alternatives)

1. Enable pnpm 11.10.0 via corepack: `corepack enable && corepack prepare pnpm@11.10.0 --activate`.
2. Create `pnpm-workspace.yaml`, root `package.json`, `tsconfig.base.json`, `.oxlintrc.json`,
   `.oxfmtrc.json`, `.gitignore`, `README.md` exactly as pinned below.
3. Create the five packages `shared/`, `worker/`, `app/`, `desktop/`, `e2e/`, each with the
   pinned minimal `package.json`, a `tsconfig.json` extending the base, and `src/index.ts`
   containing exactly `export {};` (placeholder so lint/typecheck have input).
4. Run `pnpm install`. Commit the generated `pnpm-lock.yaml`.
5. Run the DoD gates. Append the §0.3 progress entry and commit per R8
   (`feat(S0.1): repo bootstrap`).

## Pinned interfaces & artifacts

`pnpm-workspace.yaml`:

```yaml
packages:
  - shared
  - worker
  - app
  - desktop
  - e2e
```

Root `package.json` (complete):

```json
{
  "name": "tavern",
  "private": true,
  "packageManager": "pnpm@11.10.0",
  "engines": { "node": ">=22.12" },
  "scripts": {
    "dev": "pnpm -r --parallel --if-present dev",
    "build": "pnpm -r --if-present build",
    "test": "pnpm -r --if-present test",
    "test:coverage": "pnpm -r --if-present test:coverage",
    "typecheck": "pnpm -r --if-present typecheck",
    "lint": "oxlint --deny-warnings",
    "format": "oxfmt",
    "format:check": "oxfmt --check"
  },
  "devDependencies": {
    "oxc-parser": "0.139.0",
    "oxfmt": "0.58.0",
    "oxlint": "1.73.0",
    "typescript": "7.0.2"
  }
}
```

(`oxc-parser` is pinned at the root now, though nothing in S0.1 uses it: S4.2's i18n gate
script `scripts/check-i18n-literals.mjs` imports it to parse TSX for JSX string literals. Pinning
it here keeps the root lockfile stable — S4.2 adds no new root devDep, only the script.)

`tsconfig.base.json` (complete — packages extend, never override strictness):

```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "moduleDetection": "force",
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": []
  }
}
```

`.oxlintrc.json` (complete):

```json
{
  "plugins": ["typescript", "react", "react-hooks", "import", "unicorn"],
  "categories": {
    "correctness": "error",
    "suspicious": "error",
    "perf": "warn"
  },
  "rules": {
    "typescript/no-explicit-any": "error",
    "typescript/no-non-null-assertion": "error"
  },
  "ignorePatterns": ["**/dist/**", "**/out/**", "**/coverage/**", "**/.wrangler/**"]
}
```

`.oxfmtrc.json` (complete — oxfmt reads `.gitignore` automatically for ignores; the
`sortTailwindcss` block is added by S4.2 once `app/src/styles/app.css` exists, not here):

```json
{
  "ignorePatterns": []
}
```

`.gitignore` (complete):

```
node_modules/
dist/
out/
coverage/
.wrangler/
.dev.vars
.dev.vars.*
*.local
.DS_Store
playwright-report/
test-results/
```

Per-package `package.json` — identical shape, only `name` differs
(`@tavern/shared` | `@tavern/worker` | `@tavern/app` | `@tavern/desktop` | `@tavern/e2e`):

```json
{
  "name": "@tavern/shared",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit"
  }
}
```

(Packages export TS source directly — every consumer (Vite, wrangler, vitest, electron-vite)
bundles TS; there is no build step for `shared`. Later steps add each package's real
`dependencies`/`scripts`; S0.1 adds none.)

Per-package `tsconfig.json` (identical in all five):

```json
{
  "extends": "../tsconfig.base.json",
  "include": ["src", "test"]
}
```

`README.md`: exactly a title line `# Tavern`, one sentence ("Voice/screen-share app for a small
friend group — see docs/PLAN.md."), and a `## Development` section listing the root scripts above.
Full quickstart content is S12.4's job.

## Tests

None (no logic exists). The DoD gates are the test.

## DoD gates (verbatim, from repo root)

- [ ] `pnpm install` → exit 0, `pnpm-lock.yaml` created
- [ ] `pnpm lint` → exit 0
- [ ] `pnpm format:check` → exit 0
- [ ] `pnpm typecheck` → exit 0 (all five packages)
- [ ] `git status --porcelain` after commit → empty

## STOP conditions (beyond global R1)

- TS 7.0.2 rejects any pinned `tsconfig.base.json` option → apply PLAN §3.7 (pin `typescript@5.9.3`
  instead, tsconfig unchanged), record the rejected option in progress.md. If 5.9.3 ALSO rejects
  it → blocker.
- oxlint 1.73.0 rejects a plugin name or rule id in `.oxlintrc.json` → blocker (do not silently
  drop the rule).
- Any package manager other than pnpm 11.10.0 gets used (check `pnpm --version`).

## Docs (consult only these)

- https://pnpm.io/workspaces
- https://oxc.rs/docs/guide/usage/linter
- https://oxc.rs/docs/guide/usage/formatter
