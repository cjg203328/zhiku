from __future__ import annotations

from dataclasses import dataclass

from .bootstrap import BootstrapService, BootstrapStatus
from .config import AppSettings
from .services.bilibili_session_broker import BilibiliSessionBroker


@dataclass
class AppState:
    settings: AppSettings
    bootstrap_status: BootstrapStatus
    bilibili_session_broker: BilibiliSessionBroker

    @classmethod
    def create(cls, settings: AppSettings) -> "AppState":
        bootstrap = BootstrapService(settings)
        status = bootstrap.initialize()
        return cls(
            settings=settings,
            bootstrap_status=status,
            bilibili_session_broker=BilibiliSessionBroker(settings),
        )
