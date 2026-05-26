#!/usr/bin/env python3
"""
Upload an Android App Bundle (.aab) to Google Play.

Exit codes:
  0  — success
  42 — version code already used (caller should bump versionCode and retry)
  1  — any other error
"""
import argparse
import sys

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaFileUpload


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
    svc = build("androidpublisher", "v3", credentials=creds, cache_discovery=False)

    try:
        edit = svc.edits().insert(packageName=args.package, body={}).execute()
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
            status, response = upload_req.next_chunk()
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
        ).execute()
        print(f"Assigned to track {args.track} as {args.status}", file=sys.stderr)

        svc.edits().commit(packageName=args.package, editId=edit_id).execute()
        print(
            f"Committed — versionCode {version_code} live on track {args.track}",
            file=sys.stderr,
        )
        return 0

    except HttpError as e:
        body = e.content.decode("utf-8", errors="replace") if e.content else ""
        print(f"HTTP {e.resp.status}", file=sys.stderr)
        print(body, file=sys.stderr)
        if "has already been used" in body:
            return 42
        return 1
    except Exception as e:
        print(f"Unexpected error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
