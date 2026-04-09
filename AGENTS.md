# Repository Guidelines

## Project Structure & Module Organization
`src/` contains the application code for the fee-split CLI. Keep orchestration in `src/index.ts`, calculation logic in `src/calculators/`, chain integrations in `src/services/`, shared types in `src/models/`, config in `src/config/`, and file/log helpers in `src/utils/`. Compiled output goes to `dist/`. Runtime artifacts such as generated reports and logs belong in `output/` and `logs/`; do not treat them as source. `distributions.json` tracks manual fee distributions. The `tests/` directory exists but is currently empty.

## Build, Test, and Development Commands
Install dependencies with `npm install`. Build with `npm run build`, which compiles TypeScript to `dist/` using `tsc`. Run the CLI with `npm start -- --start-block 77414656 --end-block 77415299` for the recommended small verification range. Validate generated reports with `npm run validate ./output/<detailed-report>.json [transfer-file.json]`. Export interval CSVs with `npm run export-csv ./output/<detailed-report>.json [output-dir]`. Remove compiled artifacts with `npm run clean`.

## Coding Style & Naming Conventions
This project uses strict TypeScript with CommonJS output and 2-space indentation. Follow the existing naming pattern: `PascalCase` for classes, `camelCase` for methods and variables, and descriptive file names with domain suffixes such as `polygon.service.ts`, `feeSplit.calculator.ts`, and `validateOutput.ts`. Prefer small, single-purpose modules. There is no configured ESLint or Prettier setup, so match the surrounding style and keep imports grouped and explicit.

## Testing Guidelines
There is no automated test runner configured yet. For changes, treat a successful `npm run build` as the minimum gate, then run the small block-range example from the README and confirm the output with `npm run validate`. Add focused tests under `tests/` when introducing logic that can be isolated; name files after the target module, for example `feeSplit.calculator.test.ts`.

## Commit & Pull Request Guidelines
Recent history uses short, imperative commit subjects such as `Add March distributions` and `Adding signer address in result (#7)`. Keep commits narrowly scoped and reference issue or PR numbers when relevant. Pull requests should describe the block-range or data-flow impact, list any config changes, and include sample output paths or screenshots only when they clarify reviewer-visible results.

## Security & Configuration Tips
Copy `.env.example` to `.env` and keep RPC credentials out of version control. Archive-capable Polygon access is required for historical balance queries. Review `SECURITY.md` before reporting sensitive issues.
