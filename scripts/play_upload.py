#!/usr/bin/env python3
"""
Upload an Android App Bundle (.aab) to Google Play.

Exit codes:
  0  — success
  42 — version code already used (caller should bump versionCode and retry)
  1  — any other error
"""
import argparse
import socket
import sys
import traceback

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaFileUpload


# Socket-level read timeout in seconds. Google's response to the FINAL upload
# chunk includes server-side processing (virus scan, signature verify,
# manifest parse) — for a ~90 MB AAB on a busy day this takes 60-120s, which
# blows the default Python socket 60s read window. We extend the SOCKET
# default rather than overriding googleapiclient's Http transport: the
# earlier `AuthorizedHttp(creds, http=httplib2.Http(timeout=300))` approach
# broke httplib2's redirect handling for the resumable-upload protocol
# ("Redirected but the response is missing a Location: header") because
# Google's `build(credentials=...)` constructs a tuned transport that we
# replaced. Setting the socket default leaves Google's transport intact and
# still extends every socket read used underneath it.
HTTP_TIMEOUT_S = 300
socket.setdefaulttimeout(HTTP_TIMEOUT_S)

# Per-call retry budget for transient HTTP failures (503, connection reset,
# read timeout). googleapiclient's next_chunk() and execute() both honor
# this. 3 attempts has been Google's documented recommendation; matches
# the implicit retry-on-collision loop one layer up in
# scripts/upload-android-with-retry.sh.
NUM_RETRIES = 3


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--package", required=True)
    p.add_argument("--aab", required=True)
    p.add_argument("--service-account", required=True)
    p.add_argument("--track", default="internal")
    p.add_argument(
        "--status",
        default="draft",
        choices=["draft", "completed", "inProgress", "halted"],
    )
    args = p.parse_args()

    creds = service_account.Credentials.from_service_account_file(
        args.service_account,
        scopes=["https://www.googleapis.com/auth/androidpublisher"],
    )
    # Use Google's default-constructed authorized transport. Combined with
    # the module-level socket.setdefaulttimeout() above, this gives the
    # transport a 300s socket read window WITHOUT breaking its redirect /
    # resumable-upload behavior (which a custom Http() override does).
    svc = build("androidpublisher", "v3", credentials=creds, cache_discovery=False)

    try:
        edit = (
            svc.edits()
            .insert(packageName=args.package, body={})
            .execute(num_retries=NUM_RETRIES)
        )
        edit_id = edit["id"]
        print(f"Created edit {edit_id}", file=sys.stderr)

        # Resumable upload with explicit chunking. Calling `.execute()` on a
        # resumable=True request sends the whole AAB in ONE HTTP body — which
        # blows the googleapiclient default 60s socket read timeout for any
        # AAB above ~50 MB on a normal connection ("read operation timed out"
        # exactly 60s after `Created edit X`). The `next_chunk()` loop is the
        # only way to actually USE the resumable upload session; each chunk
        # gets its own fresh timeout window and progress is reported.
        #
        # 5 MiB chunksize is the Google-recommended balance: large enough to
        # avoid too many round trips (a 90 MB AAB → ~18 chunks), small enough
        # that each chunk fits comfortably inside the 60s read window even on
        # slow CI runners.
        media = MediaFileUpload(
            args.aab,
            mimetype="application/octet-stream",
            resumable=True,
            chunksize=5 * 1024 * 1024,
        )
        upload_req = (
            svc.edits()
            .bundles()
            .upload(
                packageName=args.package,
                editId=edit_id,
                media_body=media,
            )
        )
        response = None
        last_pct = -1
        while response is None:
            # num_retries covers transient 5xx / connection resets so a
            # single flaky chunk doesn't fail the whole upload.
            status, response = upload_req.next_chunk(num_retries=NUM_RETRIES)
            if status is not None:
                pct = int(status.progress() * 100)
                if pct != last_pct:
                    print(f"Upload progress: {pct}%", file=sys.stderr)
                    last_pct = pct
        bundle = response
        version_code = bundle["versionCode"]
        print(f"Uploaded versionCode {version_code}", file=sys.stderr)

        svc.edits().tracks().update(
            packageName=args.package,
            editId=edit_id,
            track=args.track,
            body={
                "releases": [
                    {"versionCodes": [str(version_code)], "status": args.status}
                ]
            },
        ).execute(num_retries=NUM_RETRIES)
        print(f"Assigned to track {args.track} as {args.status}", file=sys.stderr)

        svc.edits().commit(
            packageName=args.package, editId=edit_id
        ).execute(num_retries=NUM_RETRIES)
        print(
            f"Committed — versionCode {version_code} live on track {args.track}",
            file=sys.stderr,
        )
        return 0

    except HttpError as e:
        body = e.content.decode("utf-8", errors="replace") if e.content else ""
        print(f"HTTP {e.resp.status}", file=sys.stderr)
        print(body, file=sys.stderr)
        # Full traceback for any non-trivial failure so the CI log is
        # self-sufficient for root-causing without re-running.
        traceback.print_exc(file=sys.stderr)
        if "has already been used" in body:
            return 42
        return 1
    except Exception as e:
        print(f"Unexpected error: {type(e).__name__}: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
