#!/usr/bin/env python3
"""Deprecated: Kin Office uses packaged sdk-all-min.js bundles, not source loaders."""

from __future__ import annotations

import sys


def main() -> int:
    print(
        "generate-kinoffice-source-loaders.py is deprecated.\n"
        "Use scripts/build-euro-office-sdk-bundles.sh to build sdk-all-min.js "
        "from vendor/kin-office/source/sdkjs.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
