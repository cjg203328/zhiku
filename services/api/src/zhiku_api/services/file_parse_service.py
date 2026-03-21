from __future__ import annotations

from pathlib import Path
from zipfile import ZipFile
import xml.etree.ElementTree as ET


SUPPORTED_TEXT_EXTENSIONS = {".txt", ".md", ".markdown"}
SUPPORTED_RICH_TEXT_EXTENSIONS = {".docx"}
SUPPORTED_PLACEHOLDER_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg"}


class FileParseError(RuntimeError):
    pass


class FileParseService:
    def extract(self, file_path: str, *, original_name: str | None = None) -> dict:
        path = Path(file_path)
        if not path.exists() or not path.is_file():
            raise FileParseError("文件不存在或不可读取")

        suffix = path.suffix.lower()
        display_name = Path(original_name).name if original_name else path.name
        title = Path(original_name).stem if original_name else path.stem

        if suffix in SUPPORTED_TEXT_EXTENSIONS:
            text = path.read_text(encoding="utf-8", errors="ignore")
        elif suffix in SUPPORTED_RICH_TEXT_EXTENSIONS:
            text = self._extract_docx_text(path)
        elif suffix in SUPPORTED_PLACEHOLDER_EXTENSIONS:
            text = f"文件 {display_name} 已进入导入流程，当前骨架版本尚未接入 {suffix} 的完整解析。"
        else:
            raise FileParseError(f"暂不支持的文件类型：{suffix or '无扩展名'}")

        clean_text = text.strip()
        summary = self._build_summary(clean_text)
        key_points = self._build_key_points(clean_text)

        return {
            "source_type": "file",
            "platform": "local_file",
            "source_file": str(path),
            "title": title,
            "author": None,
            "content_text": clean_text,
            "summary": summary,
            "key_points": key_points,
            "quotes": [],
            "category": "本地导入",
            "content_type": suffix.lstrip(".") or "file",
            "use_case": "参考",
            "tags": ["本地文件", suffix.lstrip(".").upper() if suffix else "FILE"],
            "metadata": {
                "suffix": suffix,
                "size_bytes": path.stat().st_size,
                "original_name": display_name,
            },
            "local_path": str(path),
            "status": "ready",
        }

    def _extract_docx_text(self, path: Path) -> str:
        try:
            with ZipFile(path) as archive:
                document_xml = archive.read("word/document.xml")
        except Exception as exc:
            raise FileParseError("DOCX 解析失败") from exc

        root = ET.fromstring(document_xml)
        namespace = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
        paragraphs = []
        for paragraph in root.findall(".//w:p", namespace):
            texts = [node.text for node in paragraph.findall(".//w:t", namespace) if node.text]
            content = "".join(texts).strip()
            if content:
                paragraphs.append(content)
        return "\n".join(paragraphs)

    def _build_summary(self, text: str) -> str:
        if not text:
            return "导入完成，但当前未提取到可用正文。"
        text = text.replace("\n", " ").strip()
        return text[:120] + ("..." if len(text) > 120 else "")

    def _build_key_points(self, text: str) -> list[str]:
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        return lines[:3] if lines else ["当前内容尚未提炼出结构化要点。"]
