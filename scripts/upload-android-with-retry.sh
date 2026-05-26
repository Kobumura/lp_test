#!/usr/bin/env bash
# Build a signed AAB and upload to Google Play, retrying on versionCode
# collision (HTTP 400 "Version code N has already been used"). On collision,
# bump versionCode by 1, rebuild, and try again — up to MAX_ATTEMPTS times.
#
# Required env vars:
#   PACKAGE_NAME                          e.g. com.SaveYour
#   GRADLE_DIR                            e.g. ./private-repo/android (relative to cwd or absolute)
#   AAB_PATH                              path to the AAB after bundleRelease
#   SA_JSON                               path to Google Play service account JSON
#   TRACK                                 internal | alpha | beta | production
#   STATUS                                draft | completed | inProgress | halted
#   INITIAL_VERSION_CODE                  starting versionCode for attempt 1
#   ANDROID_RELEASE_KEYSTORE_PASSWORD
#   ANDROID_RELEASE_KEY_ALIAS
#   ANDROID_RELEASE_KEY_PASSWORD
# Optional:
#   MAX_ATTEMPTS                          default 10
set -euo pipefail

MAX_ATTEMPTS="${MAX_ATTEMPTS:-10}"
VERSION_CODE="${INITIAL_VERSION_CODE}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GRADLE_FILE="$GRADLE_DIR/app/build.gradle"

echo "Build & upload with collision retry"
echo "  package          = $PACKAGE_NAME"
echo "  initial vcode    = $VERSION_CODE"
echo "  max attempts     = $MAX_ATTEMPTS"
echo "  track / status   = $TRACK / $STATUS"

# Install Python deps once. --user keeps it out of system site-packages.
# google-auth-httplib2 is a transitive dep of google-api-python-client but
# pinning it explicitly so play_upload.py's `import google_auth_httplib2`
# (used to attach a long-timeout httplib2 transport to the service) is
# guaranteed to resolve. httplib2 itself is also a transitive dep but
# pinned for the same reason.
python3 -m pip install --quiet --user \
    google-api-python-client \
    google-auth \
    google-auth-httplib2 \
    httplib2

ATTEMPT=1
while [ "$ATTEMPT" -le "$MAX_ATTEMPTS" ]; do
  echo ""
  echo "=== Attempt $ATTEMPT/$MAX_ATTEMPTS — versionCode $VERSION_CODE ==="

  # Update build.gradle versionCode in-place. Pattern matches both
  # "versionCode 1" and the React Native template "... : 1" forms.
  sed -i -E "/^[[:space:]]*versionCode/ s/[0-9]+([^0-9]*)$/$VERSION_CODE\1/" "$GRADLE_FILE"
  echo "build.gradle: $(grep -E '^[[:space:]]*versionCode' "$GRADLE_FILE")"

  # Build the AAB. Gradle's incremental build + cache makes attempt 2+ fast.
  (
    cd "$GRADLE_DIR"
    chmod +x gradlew
    ./gradlew bundleRelease \
      -PsigningKeystorePassword="$ANDROID_RELEASE_KEYSTORE_PASSWORD" \
      -PsigningKeyAlias="$ANDROID_RELEASE_KEY_ALIAS" \
      -PsigningKeyPassword="$ANDROID_RELEASE_KEY_PASSWORD" \
      -PlittleVersionCode="$VERSION_CODE"
  )

  # Upload via Python helper. Exit 42 = collision (retry-worthy);
  # 0 = success; anything else = fatal.
  set +e
  python3 "$SCRIPT_DIR/play_upload.py" \
    --package "$PACKAGE_NAME" \
    --aab "$AAB_PATH" \
    --service-account "$SA_JSON" \
    --track "$TRACK" \
    --status "$STATUS"
  RC=$?
  set -e

  case "$RC" in
    0)
      echo ""
      echo "Upload succeeded — versionCode $VERSION_CODE on attempt $ATTEMPT"
      if [ -n "${GITHUB_OUTPUT:-}" ]; then
        echo "uploaded_version_code=$VERSION_CODE" >> "$GITHUB_OUTPUT"
        echo "attempt_count=$ATTEMPT" >> "$GITHUB_OUTPUT"
      fi
      # Propagate the *actually uploaded* versionCode to the job env so
      # downstream steps (Slack, git tag, build summary) see the post-retry
      # value, not the initial pre-retry one. Append-mode is safe: GitHub
      # uses the last-written value of an env var.
      if [ -n "${GITHUB_ENV:-}" ]; then
        echo "NEXT_VERSION_CODE=$VERSION_CODE" >> "$GITHUB_ENV"
      fi
      exit 0
      ;;
    42)
      echo "versionCode $VERSION_CODE already used on Play — bumping to $((VERSION_CODE + 1)) and retrying"
      VERSION_CODE=$((VERSION_CODE + 1))
      ATTEMPT=$((ATTEMPT + 1))
      ;;
    *)
      echo "Upload failed with non-collision error (exit $RC) — not retrying"
      exit "$RC"
      ;;
  esac
done

echo ""
echo "Exhausted $MAX_ATTEMPTS attempts. Last tried versionCode $((VERSION_CODE - 1))."
exit 1
