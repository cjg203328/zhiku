from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def main() -> int:
    repo_root = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(repo_root / "services" / "api" / "src"))

    from zhiku_api.config import get_settings
    from zhiku_api.services.asr_runtime_service import AsrRuntimeService

    get_settings.cache_clear()
    settings = get_settings()
    payload = AsrRuntimeService(settings).build_status_payload()

    output = {
        "python": sys.version.split()[0],
        "cwd": os.getcwd(),
        "asr": payload,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
