// normalize.mjs — LittlePipes dispatch normalizer (LP-51 / contract v1).
//
// Maps ANY accepted dispatch payload to the canonical v1 envelope so the
// decomposed capability workflows (ci / build / deploy) can be driven from one
// shape. This is the strangler seam: it does NOT change behavior — it produces a
// canonical form that PRESERVES every switch the legacy god-file reads, so a
// decomposed executor fed the normalized form behaves identically.
//
// Accepted inputs:
//   - v1            — has .schema "littlepipes.dispatch/N" (pass-through + defaults)
//   - legacy mobile — has .build_config (build-android / build-ios / build-both / ios-build)
//   - legacy php-ci — flat (target_repo/ref/sha/secrets), CI only
//
// Usage:
//   node normalize.mjs <payload-or-event.json>   # file arg, or...
//   cat event.json | node normalize.mjs          # ...stdin
// Accepts either a raw client_payload object or a full webhook event
// ({ client_payload: {...} }) and unwraps it. Secret VALUES are passed through
// untouched — masking is the workflow's job (see the entry workflow's mask step).

import { pathToFileURL } from "node:url";

const SCHEMA = "littlepipes.dispatch/1";

// Legacy mobile sends string booleans ("true"/"false"); v1 sends real booleans.
const tobool = (v, dflt = false) =>
  v === undefined || v === null || v === "" ? dflt : v === true || v === "true";

// Normalize empty/absent to null so the envelope is uniform. Used for fields the
// god-file defaults to '' (empty == unset), where null and "" are equivalent.
const str = (v) => (v === undefined || v === null || v === "" ? null : String(v));

// Mirror the god-file's `X || 'default'` semantics for fields with a NON-empty
// default: empty/absent both fall through to the default.
const def = (v, d) => (v === undefined || v === null || v === "" ? d : String(v));

export function normalize(p = {}) {
  const envelope = (intent, blocks = {}) => ({
    schema: SCHEMA,
    intent,
    target_repo: p.target_repo ?? null,
    ref: p.ref ?? "main",
    sha: p.sha ?? null,
    trigger_actor: p.trigger_actor ?? "repository_dispatch",
    status_context: p.status_context ?? "littlepipes/ci",
    correlation_id: p.correlation_id ?? null, // reserved (LP-52); unused until multi-tenant
    ci: {},
    build: {},
    app: {},
    version: {},
    deploy: {},
    ...blocks,
    secrets: p.secrets ?? {}, // last, so a block can never shadow the secrets bag
  });

  // --- already v1: pass through, but guarantee envelope defaults + all blocks exist ---
  if (typeof p.schema === "string" && p.schema.startsWith("littlepipes.dispatch/")) {
    const v = envelope(p.intent ?? "ci", {
      ci: p.ci ?? {},
      build: p.build ?? {},
      app: p.app ?? {},
      version: p.version ?? {},
      deploy: p.deploy ?? {},
    });
    // Pass the declared version through unchanged. NOTE: no version validation yet —
    // only "/1" exists. When a breaking "/2" lands, add an allow-list here and branch
    // N vs N-1; today an unknown version (e.g. "/999") sails through untouched.
    v.schema = p.schema;
    return v;
  }

  // --- legacy mobile (build_config present) ---
  if (p.build_config) {
    const bc = p.build_config;
    const ac = p.app_config ?? {};
    const vc = p.version_config ?? {};
    // Intent must mirror the god-file's ACTUAL deploy gate: the build+deploy jobs run
    // on `ci_only != 'true'` (build-on-dispatch.yaml lines 373/505) — `run_build` does
    // NOT gate them (it's just forced false under ci_only). So the faithful binary is
    // ci_only ? tests-only : build+deploy. (A `build`-without-deploy intent exists in the
    // contract but no legacy mobile payload expresses it.)
    const ciOnly = tobool(bc.ci_only); // god-file default is 'false'
    const devMode = tobool(bc.dev_mode, true); // god-file default is 'true' (line 110)
    const intent = ciOnly ? "ci" : "deploy";
    return envelope(intent, {
      ci: {
        // God-file force-sets BOTH test flags false under dev_mode, regardless of the
        // payload (lines 150-156); otherwise they default 'true' (lines 96-97). Mirror
        // that exactly — these flags mean "will actually run," which a router will trust.
        run_unit_tests: devMode ? false : tobool(bc.run_unit_tests, true),
        run_ui_tests: devMode ? false : tobool(bc.run_ui_tests, true),
        test_command: def(bc.test_command, "npm test -- --coverage --watchAll=false"), // line 106
        ui_test_flow: def(bc.ui_test_flow, ".maestro/signup-flow.yml"), // line 107
        fail_fast: tobool(bc.fail_fast, true),
      },
      build: {
        platform: def(bc.platform, "both"),
        speed: def(bc.speed, "github"),
        track: def(bc.track, "internal"), // line 108; drives Play draft-vs-completed (line 1973)
        // God-file: run_build defaults to 'true' (|| 'true'), but is force-disabled
        // under ci_only (its belt-and-suspenders at line 161). Mirror that exactly.
        run_build: ciOnly ? false : tobool(bc.run_build, true),
        dev_mode: devMode,
      },
      app: {
        // DELIBERATE divergence from the god-file's com.example.app / App / App.xcworkspace
        // placeholder defaults (lines 112-115): app identity has NO safe default — copying
        // the placeholder would let a router build/ship the WRONG bundle. null = "caller
        // must supply"; the router must fail loudly on a missing id, not fall back.
        ios_bundle_id: str(ac.ios_bundle_id),
        ios_scheme: str(ac.ios_scheme),
        ios_workspace: str(ac.ios_workspace),
        android_package_name: str(ac.android_package_name),
        apple_team_id: str(ac.apple_team_id),
      },
      version: {
        strategy: def(vc.strategy, "auto"),
        custom_version: str(vc.custom_version),
        custom_build_number: str(vc.custom_build_number),
      },
      deploy:
        intent === "deploy"
          ? {
              kind: "store", // mobile ships to App Store / Play; keys travel masked in secrets
              release_stage: p.release_stage ?? "production", // god-file's default
              track: def(bc.track, "internal"),
            }
          : {},
    });
  }

  // --- legacy php-ci (flat) — CI only, empty capability blocks (executor defaults) ---
  return envelope("ci");
}

// --- CLI entry (only when run directly, not when imported by the test) ---
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readFileSync } = await import("node:fs");
  const arg = process.argv[2];
  const raw = arg ? readFileSync(arg, "utf8") : readFileSync(0, "utf8");
  const input = JSON.parse(raw);
  const payload = input.client_payload ?? input; // accept full event or bare payload
  process.stdout.write(JSON.stringify(normalize(payload), null, 2) + "\n");
}
