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

// Normalize empty/absent to null so the envelope is uniform.
const str = (v) => (v === undefined || v === null || v === "" ? null : String(v));

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
    v.schema = p.schema; // preserve the exact declared version (supports N and N-1)
    return v;
  }

  // --- legacy mobile (build_config present) ---
  if (p.build_config) {
    const bc = p.build_config;
    const ac = p.app_config ?? {};
    const vc = p.version_config ?? {};
    // Intent derivation: ci_only wins; else a build is (in current mobile reality) a
    // ship-to-store, so run_build => deploy. Raw switches are preserved in the blocks
    // regardless, so behavior is reproducible even if this heuristic is refined later.
    const intent = tobool(bc.ci_only) ? "ci" : tobool(bc.run_build) ? "deploy" : "ci";
    return envelope(intent, {
      ci: {
        run_unit_tests: tobool(bc.run_unit_tests, true),
        run_ui_tests: tobool(bc.run_ui_tests, true),
        test_command: str(bc.test_command),
        ui_test_flow: str(bc.ui_test_flow),
        fail_fast: tobool(bc.fail_fast, true),
      },
      build: {
        platform: bc.platform ?? "both",
        speed: bc.speed ?? "github",
        track: str(bc.track),
        run_build: tobool(bc.run_build),
        dev_mode: tobool(bc.dev_mode, true),
      },
      app: {
        ios_bundle_id: str(ac.ios_bundle_id),
        ios_scheme: str(ac.ios_scheme),
        ios_workspace: str(ac.ios_workspace),
        android_package_name: str(ac.android_package_name),
        apple_team_id: str(ac.apple_team_id),
      },
      version: {
        strategy: vc.strategy ?? "auto",
        custom_version: str(vc.custom_version),
        custom_build_number: str(vc.custom_build_number),
      },
      deploy:
        intent === "deploy"
          ? {
              kind: "store", // mobile ships to App Store / Play; keys travel masked in secrets
              release_stage: p.release_stage ?? "production", // god-file's default
              track: str(bc.track),
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
