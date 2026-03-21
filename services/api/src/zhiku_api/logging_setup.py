from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler

from .config import AppSettings


class _TraceIdFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            from .main import request_trace_id
            record.trace_id = request_trace_id.get("-")
        except Exception:
            record.trace_id = "-"
        return True


def configure_logging(settings: AppSettings) -> None:
    logger = logging.getLogger()
    logger.setLevel(logging.INFO)

    if logger.handlers:
        return

    formatter = logging.Formatter(
        fmt="%(asctime)s [%(levelname)s] [%(trace_id)s] %(name)s - %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    trace_filter = _TraceIdFilter()

    console_handler = logging.StreamHandler()
    console_handler.setFormatter(formatter)
    console_handler.addFilter(trace_filter)
    logger.addHandler(console_handler)

    try:
        settings.log_dir.mkdir(parents=True, exist_ok=True)
        app_log = settings.log_dir / "service.log"
        file_handler = RotatingFileHandler(app_log, maxBytes=1_048_576, backupCount=3, encoding="utf-8")
        file_handler.setFormatter(formatter)
        file_handler.addFilter(trace_filter)
        logger.addHandler(file_handler)
    except OSError as exc:
        logger.warning("File logging disabled for %s: %s", settings.log_dir, exc)