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

        media = MediaFileUpload(
            args.aab, mimetype="application/octet-stream", resumable=True
        )
        bundle = (
            svc.edits()
            .bundles()
            .upload(
                packageName=args.package,
                editId=edit_id,
                media_body=media,
            )
            .execute()
        )
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
