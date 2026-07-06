// Local proof for the dispatch normalizer (LP-51). Run: node --test scripts/dispatch/
//
// Fixtures below are the REAL payloads the live triggers send today (copied from
// SaveYour's ci-dispatch.yml / dispatch-release.yml and SnappShot's trigger-ci.yaml),
// so a green run here means "the normalizer faithfully round-trips production traffic."

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize } from "./normalize.mjs";

// SaveYour ci-dispatch.yml — CI-only run (string booleans, release_stage:"ci")
const legacyMobileCi = {
  target_repo: "Kobumura/SaveYour",
  ref: "refs/heads/dev",
  sha: "a1b2c3d4",
  trigger_actor: "steve",
  release_stage: "ci",
  status_context: "littlepipes/ci",
  build_config: {
    platform: "android",
    speed: "github",
    ci_only: "true",
    dev_mode: "false",
    run_unit_tests: "true",
    run_ui_tests: "true",
    run_build: "false",
    fail_fast: "true",
    test_command: "npm run ci:all",
    ui_test_flow: ".maestro/smoke/smoke-test.yaml",
  },
  secrets: { TARGET_REPO_TOKEN: "ghs_fake" },
};

// SaveYour dispatch-release.yml — production release (no release_stage → god-file defaults it)
const legacyMobileRelease = {
  target_repo: "Kobumura/SaveYour",
  ref: "refs/tags/v1.4.0",
  sha: "deadbeef",
  trigger_actor: "steve",
  build_config: {
    platform: "android",
    speed: "github",
    track: "production",
    dev_mode: "true",
    run_ui_tests: "false",
    run_unit_tests: "true",
    run_build: "true",
    fail_fast: "true",
  },
  version_config: { strategy: "auto", custom_version: "", custom_build_number: "" },
  app_config: {
    android_package_name: "com.kobumura.saveyour",
    ios_bundle_id: "",
    ios_scheme: "",
    ios_workspace: "",
    apple_team_id: "",
  },
  secrets: { TARGET_REPO_TOKEN: "ghs_fake", GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_B64: "eyJ...", ANDROID_KEYSTORE_BASE64: "AAA..." },
};

// SnappShot trigger-ci.yaml — flat php-ci payload
const legacyPhpCi = {
  target_repo: "Kobumura/snappshot",
  ref: "add-littlepipes-ci-trigger",
  sha: "c0ffee00",
  trigger_actor: "dorothy",
  secrets: { TARGET_REPO_TOKEN: "ghs_fake" },
};

// A native v1 dispatch (what tenants will send post-migration)
const nativeV1 = {
  schema: "littlepipes.dispatch/1",
  intent: "build",
  target_repo: "Kobumura/newapp",
  ref: "main",
  sha: "abcdef12",
  correlation_id: "run-42",
  ci: { gates: ["style", "static"], test_command: "npm test" },
  build: { platform: "ios", speed: "buildjet" },
  secrets: { TARGET_REPO_TOKEN: "ghs_fake" },
};

test("legacy mobile CI → intent ci; behavioral switches preserved; no deploy block", () => {
  const v = normalize(legacyMobileCi);
  assert.equal(v.schema, "littlepipes.dispatch/1");
  assert.equal(v.intent, "ci");
  assert.equal(v.target_repo, "Kobumura/SaveYour");
  assert.equal(v.status_context, "littlepipes/ci");
  assert.equal(v.ci.test_command, "npm run ci:all");
  assert.equal(v.ci.ui_test_flow, ".maestro/smoke/smoke-test.yaml");
  assert.equal(v.ci.run_unit_tests, true);
  assert.equal(v.ci.run_ui_tests, true);
  assert.equal(v.build.run_build, false); // "false" → false
  assert.equal(v.build.dev_mode, false); // "false" → false, not the default true
  assert.equal(v.build.platform, "android");
  assert.deepEqual(v.deploy, {}); // ci intent → no deploy
});

test("legacy mobile release → intent deploy; store kind; production defaulted; app/version carried", () => {
  const v = normalize(legacyMobileRelease);
  assert.equal(v.intent, "deploy");
  assert.equal(v.build.run_build, true);
  assert.equal(v.build.track, "production");
  assert.equal(v.deploy.kind, "store");
  assert.equal(v.deploy.release_stage, "production"); // absent in payload → defaulted
  assert.equal(v.app.android_package_name, "com.kobumura.saveyour");
  assert.equal(v.version.strategy, "auto");
  assert.equal(v.version.custom_version, null); // "" → null
  // dev_mode:"true" in this fixture → god-file force-skips tests (lines 150-156), even
  // though run_unit_tests:"true" is in the payload. The envelope must reflect that.
  assert.equal(v.build.dev_mode, true);
  assert.equal(v.ci.run_unit_tests, false);
  assert.equal(v.ci.run_ui_tests, false);
  // test_command/ui_test_flow absent in this fixture → god-file's non-empty defaults
  assert.equal(v.ci.test_command, "npm test -- --coverage --watchAll=false");
  assert.equal(v.ci.ui_test_flow, ".maestro/signup-flow.yml");
});

test("dev_mode forces both test flags false regardless of payload (god-file lines 150-156)", () => {
  const v = normalize({
    target_repo: "x/y", sha: "z",
    build_config: { ci_only: "false", dev_mode: "true", run_unit_tests: "true", run_ui_tests: "true" },
  });
  assert.equal(v.ci.run_unit_tests, false);
  assert.equal(v.ci.run_ui_tests, false);
});

test("track/test_command/ui_test_flow fall back to the god-file's NON-empty defaults when absent", () => {
  const v = normalize({ target_repo: "x/y", sha: "z", build_config: { ci_only: "true" } });
  assert.equal(v.build.track, "internal"); // line 108
  assert.equal(v.ci.test_command, "npm test -- --coverage --watchAll=false"); // line 106
  assert.equal(v.ci.ui_test_flow, ".maestro/signup-flow.yml"); // line 107
});

test("app identity has NO default — absent ids are null, not com.example.app (deliberate divergence)", () => {
  const v = normalize({ target_repo: "x/y", sha: "z", build_config: { ci_only: "false" } });
  assert.equal(v.app.android_package_name, null);
  assert.equal(v.app.ios_bundle_id, null);
});

test("legacy php-ci flat → intent ci; empty capability blocks; coords carried", () => {
  const v = normalize(legacyPhpCi);
  assert.equal(v.intent, "ci");
  assert.equal(v.target_repo, "Kobumura/snappshot");
  assert.equal(v.sha, "c0ffee00");
  assert.deepEqual(v.ci, {});
  assert.deepEqual(v.build, {});
  assert.deepEqual(v.deploy, {});
});

test("v1 pass-through preserves schema, intent, blocks, and reserved correlation_id", () => {
  const v = normalize(nativeV1);
  assert.equal(v.schema, "littlepipes.dispatch/1");
  assert.equal(v.intent, "build");
  assert.equal(v.correlation_id, "run-42");
  assert.deepEqual(v.ci.gates, ["style", "static"]);
  assert.equal(v.build.platform, "ios");
  assert.deepEqual(v.deploy, {}); // absent in input, guaranteed to exist as {}
});

test("string-boolean coercion + defaults: ci_only:'false' + run_build:'true' → deploy, dev_mode default true", () => {
  const v = normalize({ target_repo: "x/y", sha: "z", build_config: { ci_only: "false", run_build: "true" } });
  assert.equal(v.intent, "deploy");
  assert.equal(v.build.dev_mode, true); // absent → default true
  assert.equal(v.build.platform, "both"); // absent → default both
});

test("faithfulness: not-ci_only, run_build absent → deploy + run_build defaults true (god-file gates deploy on ci_only, NOT run_build)", () => {
  // No live payload sends this combo today, but the god-file's build+deploy jobs run
  // whenever ci_only != 'true' regardless of run_build (build-on-dispatch lines 373/505),
  // and run_build defaults to 'true' (line 98). The normalizer must agree, or a future
  // router would run CI-only where the god-file would have shipped.
  const v = normalize({ target_repo: "x/y", sha: "z", build_config: { ci_only: "false" } });
  assert.equal(v.intent, "deploy");
  assert.equal(v.build.run_build, true); // absent → god-file default 'true'
  assert.equal(v.deploy.kind, "store");
});

test("faithfulness: an EXPLICIT run_build:false is honored (not overridden by the default)", () => {
  const v = normalize({ target_repo: "x/y", sha: "z", build_config: { ci_only: "false", run_build: "false" } });
  assert.equal(v.intent, "deploy"); // still deploys — ci_only is the gate, not run_build
  assert.equal(v.build.run_build, false); // explicit "false" respected
});

test("faithfulness: ci_only forces run_build false even if payload says run_build:true", () => {
  const v = normalize({ target_repo: "x/y", sha: "z", build_config: { ci_only: "true", run_build: "true" } });
  assert.equal(v.intent, "ci");
  assert.equal(v.build.run_build, false); // ci_only wins (god-file line 161 belt-and-suspenders)
  assert.deepEqual(v.deploy, {});
});

test("secrets bag passed through untouched (masking is the workflow's job)", () => {
  const v = normalize({ target_repo: "x/y", sha: "z", secrets: { TARGET_REPO_TOKEN: "t", FOO: "bar" } });
  assert.equal(v.secrets.TARGET_REPO_TOKEN, "t");
  assert.equal(v.secrets.FOO, "bar");
});

test("required coords surface as null when absent (workflow validates, normalizer doesn't throw)", () => {
  const v = normalize({});
  assert.equal(v.target_repo, null);
  assert.equal(v.sha, null);
  assert.equal(v.intent, "ci");
});
