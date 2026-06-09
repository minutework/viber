import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CLASSIFIER_VERSION,
  classifyCommand,
  classifyTestOutput,
  type CommandKind,
  type TestOutcome,
} from "../src/command-classifier.ts";

test("CLASSIFIER_VERSION is a frozen semver string", () => {
  assert.equal(CLASSIFIER_VERSION, "1.0.0");
  assert.match(CLASSIFIER_VERSION, /^\d+\.\d+\.\d+$/);
});

const COMMAND_CASES: Array<[string, CommandKind]> = [
  // test
  ["pytest", "test"],
  ["pytest -k foo tests/", "test"],
  ["python -m pytest -x", "test"],
  ["poetry run pytest -k foo", "test"],
  ["poetry run python manage.py test apps.gateway_api", "test"],
  ["./manage.py test", "test"],
  ["go test ./...", "test"],
  ["timeout 60 go test ./...", "test"],
  ["cargo test --workspace", "test"],
  ["npm test", "test"],
  ["pnpm test", "test"],
  ["yarn test --watch=false", "test"],
  ["npm run test:unit", "test"],
  ["pnpm run test", "test"],
  ["MW_X=1 pnpm -C mcp exec vitest run", "test"],
  ["npx jest --ci", "test"],
  ["npx playwright test", "test"],
  ["cypress run", "test"],
  ["node --test tests/", "test"],
  ["rspec spec/models", "test"],
  ["phpunit --filter Foo", "test"],
  ["make test", "test"],
  // chaining: test wins over earlier recognized kinds
  ["cd app && poetry run pytest -k foo", "test"],
  ["pnpm lint && pnpm test", "test"],
  ["pnpm build; pnpm vitest run", "test"],
  ["git add -A && npm test", "test"],
  // typecheck
  ["tsc -p tsconfig.json --noEmit", "typecheck"],
  ["npx tsc --noEmit", "typecheck"],
  ["mypy apps/", "typecheck"],
  ["pyright", "typecheck"],
  ["vue-tsc --noEmit", "typecheck"],
  ["pnpm typecheck", "typecheck"],
  ["npm run type-check", "typecheck"],
  // lint
  ["eslint . --max-warnings 0", "lint"],
  ["ruff check .", "lint"],
  ["flake8", "lint"],
  ["golangci-lint run", "lint"],
  ["cargo clippy -- -D warnings", "lint"],
  ["pnpm lint:fix", "lint"],
  ["stylelint src/**/*.css", "lint"],
  // format
  ["prettier --write .", "format"],
  ["ruff format .", "format"],
  ["black .", "format"],
  ["gofmt -w .", "format"],
  ["rustfmt src/main.rs", "format"],
  ["npm run fmt", "format"],
  // build
  ["webpack --mode production", "build"],
  ["vite build", "build"],
  ["next build", "build"],
  ["cargo build --release", "build"],
  ["go build ./...", "build"],
  ["make", "build"],
  ["make dist", "build"],
  ["tsc --build", "build"],
  ["pnpm build", "build"],
  ["docker build -t app .", "build"],
  ["./gradlew build", "build"],
  ["mvn package", "build"],
  // chaining: first recognized non-other segment wins when no test segment
  ["npm install && npm run build", "install"],
  ["eslint . && prettier --check .", "lint"],
  // install
  ["npm install", "install"],
  ["npm ci", "install"],
  ["pnpm install --frozen-lockfile", "install"],
  ["yarn install", "install"],
  ["pip install -r requirements.txt", "install"],
  ["poetry install", "install"],
  ["cargo add serde", "install"],
  ["brew install jq", "install"],
  ["sudo apt-get install -y curl", "install"],
  // git
  ["git status", "git"],
  ['git commit -m "fix: thing"', "git"],
  ["gh pr create --fill", "git"],
  ["FOO=bar git push origin main", "git"],
  // run
  ["npm start", "run"],
  ["node scripts/dev.js", "run"],
  ["python server.py", "run"],
  ["uvicorn app:app --reload", "run"],
  ["next dev", "run"],
  ["vite", "run"],
  ["python manage.py runserver 0.0.0.0:8000", "run"],
  ["pnpm dev", "run"],
  ["yarn start", "run"],
  // other
  ["ls -la", "other"],
  ["cat package.json", "other"],
  ["", "other"],
  ["cd apps && ls", "other"],
  ["echo done", "other"],
  ["curl https://example.com", "other"],
];

for (const [command, expected] of COMMAND_CASES) {
  test(`classifyCommand(${JSON.stringify(command)}) -> ${expected}`, () => {
    assert.equal(classifyCommand(command), expected);
  });
}

test("classifyCommand is deterministic across repeated calls", () => {
  for (const [command, expected] of COMMAND_CASES) {
    assert.equal(classifyCommand(command), classifyCommand(command));
    assert.equal(classifyCommand(command), expected);
  }
});

const OUTPUT_CASES: Array<[string, TestOutcome, string]> = [
  ["===== 12 passed in 3.2s =====", "pass", "pytest pass summary"],
  ["1 failed, 11 passed in 4.0s", "fail", "pytest fail beats pass"],
  ["Tests:       3 failed, 10 passed, 13 total", "fail", "jest fail summary"],
  ["Tests:       10 passed, 10 total", "pass", "jest pass summary"],
  ["# tests 33\n# pass 33\n# fail 0", "pass", "node-test tap summary with zero failures"],
  ["# tests 33\n# pass 30\n# fail 3", "fail", "node-test tap summary with failures"],
  ["not ok 22 - rejects bad input", "fail", "tap not-ok line"],
  ["src/score.ts(10,5): error TS2345: Argument of type 'string'", "fail", "tsc diagnostic"],
  ["FAILED tests/test_gateway.py::test_handoff - AssertionError", "fail", "pytest FAILED line"],
  ["PASSED", "pass", "bare PASSED marker"],
  ["All checks passed!", "pass", "ruff-style all checks passed"],
  ["✓ renders header (23ms)\n✓ handles empty state (4ms)", "pass", "checkmarks with no fail marker"],
  ["✗ should compute totals", "fail", "cross mark"],
  ['Traceback (most recent call last):\n  File "x.py", line 3', "fail", "python traceback"],
  ["npm ERR! code ELIFECYCLE", "fail", "npm error banner"],
  ["[INFO] BUILD SUCCESS", "pass", "maven build success"],
  ["ok • 12 tests done", "pass", "ok summary with test count"],
  ["2 failing\n10 passing", "fail", "mocha failing beats passing"],
  ["The function returns a list of users filtered by tenant.", null, "plain prose"],
  ["FAILSAFE mode enabled for replication", null, "FAIL inside FAILSAFE does not count"],
  ["0 failed, 12 passed in 1.1s", "pass", "zero-failed count is not a failure"],
  [" ".repeat(4500) + "12 passed in 1s", null, "scan truncates at 4000 chars"],
];

for (const [text, expected, label] of OUTPUT_CASES) {
  test(`classifyTestOutput: ${label} -> ${String(expected)}`, () => {
    assert.equal(classifyTestOutput(text), expected);
  });
}
