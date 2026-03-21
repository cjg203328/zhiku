from __future__ import annotations

import json
import mimetypes
import tempfile
import uuid
from pathlib import Path
from typing import Any
from urllib import request as urllib_request
from urllib.error import HTTPError, URLError

from ..config import AppSettings, LOCAL_ASR_PROVIDER
from .asr_runtime_service import AsrRuntimeService

BROWSER_AUDIO_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
)


class AsrSegment(dict):
    start_ms: int | None
    end_ms: int | None
    text: str


class AsrTranscript(dict):
    text: str
    segments: list[AsrSegment]
    response_format: str


class AsrGateway:
    def __init__(self, settings: AppSettings) -> None:
        self.settings = settings
        self.runtime_service = AsrRuntimeService(settings)

    def is_enabled(self) -> bool:
        return bool(self.runtime_service.build_status_payload()["available"])

    def transcribe_audio_url(
        self,
        audio_url: str,
        *,
        filename_hint: str = "audio.m4a",
        language: str | None = None,
        quality_preset: str | None = None,
        prompt: str | None = None,
    ) -> AsrTranscript | None:
        if not self.is_enabled() or not audio_url.strip():
            return None

        temp_path = self._download_audio(audio_url, filename_hint=filename_hint)
        if temp_path is None:
            return None
        try:
            return self._transcribe_file(
                temp_path,
                language=language,
                quality_preset=quality_preset,
                prompt=prompt,
            )
        finally:
            try:
                temp_path.unlink(missing_ok=True)
            except Exception:
                pass

    def transcribe_audio_url_with_strategies(
        self,
        audio_url: str,
        *,
        filename_hint: str = "audio.m4a",
        strategies: list[dict[str, Any]],
    ) -> list[AsrTranscript]:
        if not self.is_enabled() or not audio_url.strip() or not strategies:
            return []

        temp_path = self._download_audio(audio_url, filename_hint=filename_hint)
        if temp_path is None:
            return []

        results: list[AsrTranscript] = []
        seen_configs: set[tuple[str, str, str]] = set()
        try:
            for strategy in strategies:
                language = str(strategy.get("language") or "").strip() or None
                quality_preset = str(strategy.get("quality_preset") or "").strip() or None
                prompt = str(strategy.get("prompt") or "").strip() or None
                config_key = (language or "", quality_preset or "", prompt or "")
                if config_key in seen_configs:
                    continue
                seen_configs.add(config_key)

                result = self._transcribe_file(
                    temp_path,
                    language=language,
                    quality_preset=quality_preset,
                    prompt=prompt,
                )
                if result is None:
                    continue

                result["strategy_label"] = str(strategy.get("label") or "").strip()
                results.append(result)
        finally:
            try:
                temp_path.unlink(missing_ok=True)
            except Exception:
                pass

        return results

    def _download_audio(self, audio_url: str, *, filename_hint: str) -> Path | None:
        suffix = Path(filename_hint).suffix or ".m4a"
        temp_path = Path(tempfile.gettempdir()) / "Zhiku" / f"asr-{uuid.uuid4().hex}{suffix}"
        temp_path.parent.mkdir(parents=True, exist_ok=True)
        request = urllib_request.Request(
            audio_url,
            headers={
                "User-Agent": BROWSER_AUDIO_UA,
                "Referer": "https://www.bilibili.com/",
                "Origin": "https://www.bilibili.com",
            },
            method="GET",
        )
        try:
            with urllib_request.urlopen(request, timeout=max(self.settings.llm_timeout_seconds, 60.0)) as response:
                temp_path.write_bytes(response.read())
        except Exception:
            return None
        return temp_path if temp_path.exists() and temp_path.stat().st_size > 0 else None

    def _transcribe_file(
        self,
        path: Path,
        *,
        language: str | None,
        quality_preset: str | None,
        prompt: str | None,
    ) -> AsrTranscript | None:
        if self.settings.asr_effective_provider == LOCAL_ASR_PROVIDER:
            return self.runtime_service.transcribe_file(
                path,
                model=self.settings.asr_effective_model,
                language=language,
                quality_preset=quality_preset,
                prompt=prompt,
            )

        verbose_payload = self._request_transcription(
            path,
            response_format="verbose_json",
            include_segment_timestamps=True,
            language=language,
            prompt=prompt,
        )
        verbose_result = self._parse_transcription_payload(
            verbose_payload,
            response_format="verbose_json",
            language=language,
            quality_preset=quality_preset,
            prompt=prompt,
        )
        if verbose_result is not None:
            return verbose_result

        basic_payload = self._request_transcription(
            path,
            response_format="json",
            include_segment_timestamps=False,
            language=language,
            prompt=prompt,
        )
        return self._parse_transcription_payload(
            basic_payload,
            response_format="json",
            language=language,
            quality_preset=quality_preset,
            prompt=prompt,
        )

    def _request_transcription(
        self,
        path: Path,
        *,
        response_format: str,
        include_segment_timestamps: bool,
        language: str | None,
        prompt: str | None,
    ) -> dict[str, Any] | None:
        endpoint = self._resolve_transcribe_endpoint(self.settings.asr_effective_api_base_url)
        api_key = self.settings.asr_effective_api_key
        boundary = f"----ZhikuBoundary{uuid.uuid4().hex}"
        body = self._build_multipart_body(
            path,
            boundary,
            response_format=response_format,
            include_segment_timestamps=include_segment_timestamps,
            language=language,
            prompt=prompt,
        )
        request = urllib_request.Request(
            endpoint,
            data=body,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": f"multipart/form-data; boundary={boundary}",
            },
            method="POST",
        )
        try:
            with urllib_request.urlopen(request, timeout=max(self.settings.llm_timeout_seconds, 90.0)) as response:
                return json.loads(response.read().decode("utf-8"))
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError):
            return None
        except Exception:
            return None

    def _parse_transcription_payload(
        self,
        payload: dict[str, Any] | None,
        *,
        response_format: str,
        language: str | None,
        quality_preset: str | None,
        prompt: str | None,
    ) -> AsrTranscript | None:
        if not isinstance(payload, dict):
            return None

        text = payload.get("text")
        normalized_text = text.strip() if isinstance(text, str) and text.strip() else ""
        segments = self._parse_segments(payload.get("segments"))

        if not normalized_text and segments:
            normalized_text = " ".join(item["text"] for item in segments).strip()

        if not normalized_text:
            return None

        return {
            "text": normalized_text,
            "segments": segments,
            "response_format": response_format,
            "model_requested": self.settings.asr_effective_model,
            "model_used": self.settings.asr_effective_model,
            "model_auto_upgraded": False,
            "language": str(payload.get("language") or language or "").strip(),
            "quality_preset": quality_preset or "",
            "prompt_used": prompt or "",
        }

    def _resolve_transcribe_endpoint(self, base_url: str) -> str:
        candidate = base_url.strip().rstrip("/")
        if candidate.endswith("/chat/completions"):
            candidate = candidate[: -len("/chat/completions")]
        if candidate.endswith("/audio/transcriptions"):
            return candidate
        return f"{candidate}/audio/transcriptions"

    def _build_multipart_body(
        self,
        path: Path,
        boundary: str,
        *,
        response_format: str,
        include_segment_timestamps: bool,
        language: str | None,
        prompt: str | None,
    ) -> bytes:
        mime_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        file_bytes = path.read_bytes()
        lines: list[bytes] = []

        def add_text_field(name: str, value: str) -> None:
            lines.append(f"--{boundary}\r\n".encode())
            lines.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
            lines.append(value.encode("utf-8"))
            lines.append(b"\r\n")

        add_text_field("model", self.settings.asr_effective_model)
        add_text_field("response_format", response_format)
        if language:
            add_text_field("language", language)
        if prompt:
            add_text_field("prompt", prompt)
        if include_segment_timestamps:
            add_text_field("timestamp_granularities[]", "segment")

        lines.append(f"--{boundary}\r\n".encode())
        lines.append(
            f'Content-Disposition: form-data; name="file"; filename="{path.name}"\r\n'.encode()
        )
        lines.append(f"Content-Type: {mime_type}\r\n\r\n".encode())
        lines.append(file_bytes)
        lines.append(b"\r\n")
        lines.append(f"--{boundary}--\r\n".encode())
        return b"".join(lines)

    def _parse_segments(self, raw_segments: Any) -> list[AsrSegment]:
        if not isinstance(raw_segments, list):
            return []

        segments: list[AsrSegment] = []
        for item in raw_segments:
            if not isinstance(item, dict):
                continue
            text = str(item.get("text") or "").strip()
            if not text:
                continue
            segments.append(
                {
                    "start_ms": self._seconds_to_milliseconds(item.get("start")),
                    "end_ms": self._seconds_to_milliseconds(item.get("end")),
                    "text": text,
                }
            )
        return segments

    def _seconds_to_milliseconds(self, value: Any) -> int | None:
        if value is None:
            return None
        try:
            seconds = float(value)
        except (TypeError, ValueError):
            return None
        if seconds < 0:
            return None
        return int(seconds * 1000)
