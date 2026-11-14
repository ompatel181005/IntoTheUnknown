#!/usr/bin/env python3
"""Update one member's row in STATUS.md on main through the GitHub contents API.

Never touches the local working tree or branch. Needs the `gh` CLI, authenticated.
"""
import argparse
import base64
import json
import shutil
import subprocess
import sys
from datetime import datetime

PATH = "STATUS.md"
COLUMNS = ["Member", "Issue", "Branch", "State", "Next", "Blocked", "Updated"]
STATES = ["idle", "planning", "building", "in review", "blocked", "away"]
MAX_TRIES = 3


def die(msg):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def run(cmd, stdin=None):
    return subprocess.run(cmd, input=stdin, capture_output=True, text=True)


def check_gh():
    if shutil.which("gh") is None:
        die("`gh` is not installed. Install it from https://cli.github.com/ and run `gh auth login`.")
    if run(["gh", "auth", "status"]).returncode != 0:
        die("`gh` is not authenticated. Run `gh auth login`.")


def repo_slug():
    r = run(["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"])
    if r.returncode != 0 or not r.stdout.strip():
        die("could not determine the repo. Run this inside the repo clone.\n" + r.stderr.strip())
    return r.stdout.strip()


def api_get(slug):
    r = run(["gh", "api", f"repos/{slug}/contents/{PATH}?ref=main"])
    if r.returncode != 0:
        die(f"could not read {PATH} on main.\n{r.stderr.strip()}")
    data = json.loads(r.stdout)
    return base64.b64decode(data["content"]).decode("utf-8"), data["sha"]


def api_put(slug, text, sha, message):
    body = json.dumps({
        "message": message,
        "content": base64.b64encode(text.encode("utf-8")).decode("ascii"),
        "sha": sha,
        "branch": "main",
    })
    r = run(["gh", "api", "--method", "PUT", f"repos/{slug}/contents/{PATH}", "--input", "-"], stdin=body)
    if r.returncode == 0:
        return "ok"
    err = r.stdout + r.stderr
    if "409" in err or "does not match" in err:
        return "conflict"
    die(f"write failed.\n{err.strip()}")


def split_row(line):
    return [c.strip() for c in line.strip().strip("|").split("|")]


def join_row(cells):
    return "| " + " | ".join(cells) + " |"


def update(text, args):
    lines = text.split("\n")
    header = next((i for i, l in enumerate(lines) if l.startswith("|") and split_row(l)[0] == "Member"), None)
    if header is None:
        die("could not find the table header in STATUS.md.")
    hit = None
    for i in range(header + 2, len(lines)):
        if not lines[i].startswith("|"):
            break
        if split_row(lines[i])[0] == args.member:
            hit = i
            break
    if hit is None:
        die(f"no row with Member '{args.member}' in STATUS.md. Edit the Member cell on main first (one row per person).")
    cells = split_row(lines[hit])
    cells += [""] * (len(COLUMNS) - len(cells))
    for idx, val in ((1, args.issue), (2, args.branch), (3, args.state), (4, args.next), (5, args.blocked)):
        if val is not None:
            cells[idx] = val.replace("|", "/")
    cells[6] = datetime.now().strftime("%Y-%m-%d %H:%M")
    lines[hit] = join_row(cells)
    return "\n".join(lines)


def table(text):
    return "\n".join(l for l in text.split("\n") if l.startswith("|"))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--member", required=True)
    p.add_argument("--issue")
    p.add_argument("--branch")
    p.add_argument("--state", choices=STATES)
    p.add_argument("--next")
    p.add_argument("--blocked")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    check_gh()
    slug = repo_slug()
    for attempt in range(1, MAX_TRIES + 1):
        text, sha = api_get(slug)
        new = update(text, args)
        if args.dry_run:
            print(table(new))
            return
        if api_put(slug, new, sha, f"chore(status): {args.member}") == "ok":
            print(table(new))
            return
        print(f"sha conflict, retrying ({attempt}/{MAX_TRIES})", file=sys.stderr)
    die("gave up after repeated sha conflicts. Try again in a moment.")


if __name__ == "__main__":
    main()
