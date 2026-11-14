#!/usr/bin/env python3
"""Synthetic stand-in for the memory repo's scripts/wiki-lint.py (tests only).

The wrapper strips the environment, so behaviour is chosen by a sibling file:
`stub-exit-code` (default 0). The stub prints a canned report in the real
lint's text shape plus what it saw (argv, cwd, environment key names) so the
tests can check the wrapper's fixed command and minimal environment. Every
path in the report is invented.
"""
import json
import os
import sys
from pathlib import Path

here = Path(__file__).resolve().parent
mode_file = here / "stub-exit-code"
code = int(mode_file.read_text().strip()) if mode_file.is_file() else 0

print("STUB-ARGV " + json.dumps(sys.argv[1:]))
print("STUB-CWD " + os.getcwd())
print("STUB-ENV " + json.dumps(sorted(os.environ.keys())))
print("STUB-DONTWRITEBYTECODE " + str(sys.dont_write_bytecode))

if code == 2:
    print("ERROR   not a lintable repo root: wiki/index.md missing", file=sys.stderr)
    sys.exit(2)

print("## Deterministic wiki lint")
if code == 1:
    print("- errors: 1")
    print("- warnings: 1")
    print("ERROR   wiki/example/page.md: broken link to wiki/example/missing.md")
    print("WARNING wiki/example/other.md: orphan page")
else:
    print("- errors: 0")
    print("- warnings: 0")
    print("Clean pass — no mechanical issues found.")
sys.exit(code)
