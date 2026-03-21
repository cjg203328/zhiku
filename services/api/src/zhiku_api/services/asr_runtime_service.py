from __future__ import annotations

from dataclasses import dataclass
import importlib
import importlib.util
import shutil
from pathlib import Path
from threading import Lock
from typing import TYPE_CHECKING, Any, Callable

from ..config import LOCAL_ASR_PROVIDER

if TYPE_CHECKING:
    from ..config import AppSettings


_MODEL_CACHE: dict[tuple[str, str], Any] = {}
_MODEL_CACHE_LOCK = Lock()


@dataclass(frozen=True)
class AsrRuntimeStatus:
    local_runtime_ready: bool
    local_engine: str
    faster_whisper_installed: bool
    openai_whisper_installed: bool
    ffmpeg_available: bool
    runtime_summary: str


class AsrRuntimeService:
    def __init__(self, settings: "AppSettings | None" = None) -> None:
        self.settings = settings

    def collect(self) -> AsrRuntimeStatus:
        faster_whisper_installed = self._package_available("faster_whisper")
        openai_whisper_installed = self._package_available("whisper")
        ffmpeg_available = shutil.which("ffmpeg") is not None

        local_engine = ""
        if faster_whisper_installed:
            local_engine = "faster_whisper"
        elif openai_whisper_installed and ffmpeg_available:
            local_engine = "openai_whisper"

        return AsrRuntimeStatus(
            local_runtime_ready=bool(local_engine),
            local_engine=local_engine,
            faster_whisper_installed=faster_whisper_installed,
            openai_whisper_installed=openai_whisper_installed,
            ffmpeg_available=ffmpeg_available,
            runtime_summary=self._build_runtime_summary(
                faster_whisper_installed=faster_whisper_installed,
                openai_whisper_installed=openai_whisper_installed,
                ffmpeg_available=ffmpeg_available,
                local_engine=local_engine,
            ),
        )

    def build_status_payload(self) -> dict[str, Any]:
        runtime = self.collect()
        provider = self.settings.asr_effective_provider if self.settings is not None else ""
        model = self.settings.asr_effective_model if self.settings is not None else ""
        config_mode = self.settings.asr_config_mode if self.settings is not None else "disabled"
        selected = config_mode != "disabled"
        available = self._is_available(provider=provider, model=model, runtime=runtime)

        return {
            "selected": selected,
            "available": available,
            "configured": available,
            "provider": provider,
            "model": model,
            "api_base_url": self.settings.asr_effective_api_base_url if self.settings is not None else "",
            "api_key_configured": bool(self.settings.asr_effective_api_key.strip()) if self.settings is not None else False,
            "config_mode": config_mode,
            "inherited_from_model": self.settings.asr_inherited_from_model if self.settings is not None else False,
            "local_runtime_ready": runtime.local_runtime_ready,
            "local_engine": runtime.local_engine,
            "runtime_summary": runtime.runtime_summary,
            "summary": self._build_effective_summary(
                provider=provider,
                config_mode=config_mode,
                available=available,
                runtime=runtime,
            ),
            "recommended_action": self._build_recommended_action(
                provider=provider,
                config_mode=config_mode,
                available=available,
                runtime=runtime,
            ),
            "faster_whisper_installed": runtime.faster_whisper_installed,
            "openai_whisper_installed": runtime.openai_whisper_installed,
            "ffmpeg_available": runtime.ffmpeg_available,
        }

    def transcribe_file(
        self,
        path: Path,
        *,
        model: str,
        language: str | None = None,
        quality_preset: str | None = None,
        prompt: str | None = None,
    ) -> dict[str, Any] | None:
        runtime = self.collect()
        effective_model, auto_upgraded = self._resolve_local_model(
            model,
            language=language,
            quality_preset=quality_preset,
        )

        if runtime.faster_whisper_installed:
            faster_result = self._transcribe_with_faster_whisper(
                path,
                effective_model,
                language=language,
                quality_preset=quality_preset,
                prompt=prompt,
            )
            if faster_result is not None:
                return self._attach_transcript_meta(
                    faster_result,
                    requested_model=model,
                    used_model=effective_model,
                    auto_upgraded=auto_upgraded,
                    language=language,
                    quality_preset=quality_preset,
                    prompt=prompt,
                )
            if auto_upgraded and effective_model != model:
                fallback_result = self._transcribe_with_faster_whisper(
                    path,
                    model,
                    language=language,
                    quality_preset=quality_preset,
                    prompt=prompt,
                )
                if fallback_result is not None:
                    return self._attach_transcript_meta(
                        fallback_result,
                        requested_model=model,
                        used_model=model,
                        auto_upgraded=False,
                        language=language,
                        quality_preset=quality_preset,
                        prompt=prompt,
                    )

        if runtime.openai_whisper_installed and runtime.ffmpeg_available:
            openai_result = self._transcribe_with_openai_whisper(
                path,
                effective_model,
                language=language,
                quality_preset=quality_preset,
                prompt=prompt,
            )
            if openai_result is not None:
                return self._attach_transcript_meta(
                    openai_result,
                    requested_model=model,
                    used_model=effective_model,
                    auto_upgraded=auto_upgraded,
                    language=language,
                    quality_preset=quality_preset,
                    prompt=prompt,
                )
            if auto_upgraded and effective_model != model:
                fallback_result = self._transcribe_with_openai_whisper(
                    path,
                    model,
                    language=language,
                    quality_preset=quality_preset,
                    prompt=prompt,
                )
                if fallback_result is not None:
                    return self._attach_transcript_meta(
                        fallback_result,
                        requested_model=model,
                        used_model=model,
                        auto_upgraded=False,
                        language=language,
                        quality_preset=quality_preset,
                        prompt=prompt,
                    )

        return None

    def _is_available(self, *, provider: str, model: str, runtime: AsrRuntimeStatus) -> bool:
        if not provider.strip() or not model.strip():
            return False
        if provider == LOCAL_ASR_PROVIDER:
            return runtime.local_runtime_ready
        if self.settings is None:
            return False
        return self.settings.asr_effectively_enabled

    def _build_runtime_summary(
        self,
        *,
        faster_whisper_installed: bool,
        openai_whisper_installed: bool,
        ffmpeg_available: bool,
        local_engine: str,
    ) -> str:
        if local_engine == "faster_whisper":
            return "已检测到 faster-whisper，本机可以直接执行本地转写。"
        if local_engine == "openai_whisper":
            return "已检测到 openai-whisper 和 ffmpeg，本机可以执行本地转写。"
        if openai_whisper_installed and not ffmpeg_available:
            return "已检测到 openai-whisper，但缺少 ffmpeg，本地转写暂不可用。"
        if ffmpeg_available and not faster_whisper_installed and not openai_whisper_installed:
            return "已检测到 ffmpeg，但还没有安装 whisper 运行时。"
        return "当前未检测到可用的本地 whisper 运行时。"

    def _build_effective_summary(
        self,
        *,
        provider: str,
        config_mode: str,
        available: bool,
        runtime: AsrRuntimeStatus,
    ) -> str:
        if provider == LOCAL_ASR_PROVIDER:
            if available:
                engine_label = "faster-whisper" if runtime.local_engine == "faster_whisper" else "openai-whisper"
                return f"当前将使用 {engine_label} 在本机执行音频转写。"
            return "已选择本地转写，但当前机器还没有检测到可用的本地运行时。"

        if config_mode == "inherited" and available:
            return "当前将复用主模型配置进行音频转写。"
        if config_mode == "hybrid" and available:
            return "当前将复用主模型底座，并补充独立转写参数。"
        if config_mode == "explicit" and available:
            return "当前将使用独立接口执行音频转写。"
        if config_mode != "disabled":
            return "当前已选择音频转写模式，但还没有达到可用状态。"
        if runtime.local_runtime_ready:
            return "当前未启用音频转写，但本机已经具备本地转写运行时。"
        return "当前未启用音频转写。"

    def _build_recommended_action(
        self,
        *,
        provider: str,
        config_mode: str,
        available: bool,
        runtime: AsrRuntimeStatus,
    ) -> str:
        if provider == LOCAL_ASR_PROVIDER and not available:
            if runtime.openai_whisper_installed and not runtime.ffmpeg_available:
                return "补一个 ffmpeg，或直接安装 faster-whisper 后再重试。"
            if not runtime.faster_whisper_installed and not runtime.openai_whisper_installed:
                return "安装 faster-whisper，或安装 openai-whisper 并准备 ffmpeg。"
            return "先补齐本地转写运行时，再重新解析视频。"

        if config_mode == "inherited" and not available:
            return "先完成主模型接入，或者切换到本地转写模式。"
        if config_mode in {"explicit", "hybrid"} and not available:
            return "检查转写接口地址、模型名和 API Key 是否完整可用。"
        if config_mode == "disabled":
            if runtime.local_runtime_ready:
                return "可以直接切换到本地转写，或者继续复用主模型。"
            return "优先复用主模型，或安装本地转写运行时。"
        return "可以直接去验证 B站导入、原始转写和时间定位效果。"

    def _transcribe_with_faster_whisper(
        self,
        path: Path,
        model: str,
        *,
        language: str | None,
        quality_preset: str | None,
        prompt: str | None,
    ) -> dict[str, Any] | None:
        try:
            faster_whisper_module = importlib.import_module("faster_whisper")
            whisper_model = self._get_or_load_model(
                ("faster_whisper", model),
                lambda: faster_whisper_module.WhisperModel(model, device="cpu", compute_type="int8"),
            )
            transcribe_kwargs: dict[str, Any] = {
                "task": "transcribe",
                "beam_size": 8 if quality_preset == "video_mixed" else 7 if quality_preset == "video_zh" else 5,
                "vad_filter": True,
            }
            if language:
                transcribe_kwargs["language"] = language
            if prompt:
                transcribe_kwargs["initial_prompt"] = prompt
            raw_segments, info = whisper_model.transcribe(str(path), **transcribe_kwargs)
            segments = []
            texts: list[str] = []
            for item in raw_segments:
                text = str(getattr(item, "text", "") or "").strip()
                if not text:
                    continue
                texts.append(text)
                segments.append(
                    {
                        "start_ms": self._seconds_to_milliseconds(getattr(item, "start", None)),
                        "end_ms": self._seconds_to_milliseconds(getattr(item, "end", None)),
                        "text": text,
                    }
                )
            text = " ".join(texts).strip()
            if not text:
                return None
            return {
                "text": text,
                "segments": segments,
                "response_format": "local_verbose",
                "detected_language": str(getattr(info, "language", "") or "").strip(),
            }
        except Exception:
            return None

    def _transcribe_with_openai_whisper(
        self,
        path: Path,
        model: str,
        *,
        language: str | None,
        quality_preset: str | None,
        prompt: str | None,
    ) -> dict[str, Any] | None:
        try:
            whisper_module = importlib.import_module("whisper")
            whisper_model = self._get_or_load_model(
                ("openai_whisper", model),
                lambda: whisper_module.load_model(model),
            )
            transcribe_kwargs: dict[str, Any] = {
                "task": "transcribe",
                "verbose": False,
                "fp16": False,
            }
            if language:
                transcribe_kwargs["language"] = language
            if prompt:
                transcribe_kwargs["initial_prompt"] = prompt
            result = whisper_model.transcribe(str(path), **transcribe_kwargs)
        except Exception:
            return None

        text = str(result.get("text") or "").strip() if isinstance(result, dict) else ""
        segments = self._parse_openai_whisper_segments(result.get("segments") if isinstance(result, dict) else None)
        if not text and segments:
            text = " ".join(item["text"] for item in segments).strip()
        if not text:
            return None

        return {
            "text": text,
            "segments": segments,
            "response_format": "local_verbose",
            "detected_language": str(result.get("language") or "").strip() if isinstance(result, dict) else "",
        }

    def _parse_openai_whisper_segments(self, raw_segments: Any) -> list[dict[str, Any]]:
        if not isinstance(raw_segments, list):
            return []

        segments: list[dict[str, Any]] = []
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

    def _get_or_load_model(self, key: tuple[str, str], loader: Callable[[], Any]) -> Any:
        with _MODEL_CACHE_LOCK:
            model = _MODEL_CACHE.get(key)
            if model is not None:
                return model

        model = loader()
        with _MODEL_CACHE_LOCK:
            _MODEL_CACHE[key] = model
        return model

    def _package_available(self, package_name: str) -> bool:
        return importlib.util.find_spec(package_name) is not None

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

    def _resolve_local_model(
        self,
        model: str,
        *,
        language: str | None,
        quality_preset: str | None,
    ) -> tuple[str, bool]:
        requested = (model or "").strip() or "small"
        normalized = requested.lower()

        if language == "zh" and normalized.endswith(".en"):
            if normalized == "tiny.en":
                return "tiny", True
            if normalized == "base.en":
                return "base", True
            requested = requested[: -len(".en")]

        return requested, requested != model

    def _attach_transcript_meta(
        self,
        payload: dict[str, Any],
        *,
        requested_model: str,
        used_model: str,
        auto_upgraded: bool,
        language: str | None,
        quality_preset: str | None,
        prompt: str | None,
    ) -> dict[str, Any]:
        payload["model_requested"] = requested_model
        payload["model_used"] = used_model
        payload["model_auto_upgraded"] = auto_upgraded
        payload["language"] = str(payload.get("detected_language") or language or "").strip()
        payload["quality_preset"] = quality_preset or ""
        payload["prompt_used"] = prompt or ""
        return payload
