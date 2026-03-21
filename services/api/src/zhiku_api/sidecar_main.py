from __future__ import annotations

import uvicorn

from zhiku_api.main import app


def main() -> None:
    uvicorn.run(app, host="127.0.0.1", port=38765, log_level="info")


if __name__ == "__main__":
    main()
