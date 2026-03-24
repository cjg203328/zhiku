import type { ReactNode } from "react";

type MarkdownNoteViewProps = {
  markdown: string;
  className?: string;
};

type MarkdownBlock =
  | { kind: "heading"; level: 2 | 3; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "paragraph"; text: string };

const DROPPED_BULLET_LABELS = [
  "BVID",
  "播放",
  "点赞",
  "投币",
  "收藏",
  "转发",
  "链接",
  "来源链接",
  "笔记风格",
  "建议下一步",
  "粉丝",
  "关注",
  "弹幕",
  "分享",
  "发布时间",
  "上传时间",
];

const DROPPED_SECTION_TITLES = new Set(["可执行建议", "下一步建议"]);

const LOW_SIGNAL_PREFIXES = [
  "当前正文还不够稳定",
  "当前正文不足",
  "当前仅保留了基础",
  "当前只保留了基础",
  "当前只保留了较弱材料",
  "当前还没有提炼出稳定要点",
  "当前没有提炼出稳定要点",
  "这条视频还没有拿到可直接使用的正文",
  "内容仍需继续补齐",
];

function cleanInlineMarkdown(text: string) {
  let cleaned = text;
  cleaned = cleaned.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1");
  cleaned = cleaned.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
  cleaned = cleaned.replace(/https?:\/\/127\.0\.0\.1:\d+\/static\/[^\s)]+/g, "");
  cleaned = cleaned.replace(/https?:\/\/[^\s)]+/g, "");
  cleaned = cleaned.replace(/\*?Screenshot-(?:\[\d{2}:\d{2}(?::\d{2})?\]|\d{2}:\d{2}(?::\d{2})?)/g, "");
  cleaned = cleaned.replace(/\*\*/g, "");
  cleaned = cleaned.replace(/__/g, "");
  cleaned = cleaned.replace(/`/g, "");
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  return cleaned;
}

function shouldDropLine(text: string) {
  if (!text) {
    return true;
  }

  if (LOW_SIGNAL_PREFIXES.some((prefix) => text.startsWith(prefix))) {
    return true;
  }

  if (/^(?:打开原视频|原视频链接|源视频链接)/.test(text)) {
    return true;
  }

  if (/(?:播放|点赞|投币|收藏|转发)\s*[：:]\s*\d+/i.test(text)) {
    return true;
  }

  if (/\b(?:BV[0-9A-Za-z]+|av\d+)\b/.test(text)) {
    return true;
  }

  // 纯统计数据行（粉丝量、播放量等）
  if (/^(?:粉丝|关注|播放量|弹幕数|收藏数)[：:]\s*\d+/.test(text)) {
    return true;
  }

  // UP主主页/个人空间链接
  if (/space\.bilibili\.com/.test(text)) {
    return true;
  }

  return false;
}

function shouldDropBullet(text: string) {
  const match = text.match(/^([^：:]+)[：:]\s*(.*)$/);
  if (!match) {
    return shouldDropLine(text);
  }
  const label = match[1].trim();
  const value = match[2].trim();
  return DROPPED_BULLET_LABELS.includes(label) || !value || shouldDropLine(text);
}

export function cleanNoteMarkdownForDisplay(markdown: string) {
  if (!markdown.trim()) {
    return "";
  }

  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const cleanedLines: string[] = [];
  let skippedSection = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      if (!skippedSection) {
        cleanedLines.push("");
      }
      continue;
    }

    if (/^#\s+/.test(trimmed)) {
      continue;
    }
    if (/^>\s*BiliNote/i.test(trimmed)) {
      continue;
    }
    if (/^>\s*\[?打开原视频]?/i.test(trimmed)) {
      continue;
    }
    if (/^!\[[^\]]*\]\([^)]+\)$/.test(trimmed)) {
      continue;
    }
    if (/^https?:\/\/127\.0\.0\.1:\d+\/static\/[^\s]+$/.test(trimmed)) {
      continue;
    }

    if (/^##\s+/.test(trimmed) || /^###\s+/.test(trimmed)) {
      const prefix = trimmed.startsWith("###") ? "### " : "## ";
      const title = cleanInlineMarkdown(trimmed.replace(/^#{2,3}\s+/, ""));
      skippedSection = DROPPED_SECTION_TITLES.has(title);
      if (skippedSection) {
        continue;
      }
      if (title) {
        cleanedLines.push(`${prefix}${title}`);
      }
      continue;
    }

    if (skippedSection) {
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const bulletText = cleanInlineMarkdown(trimmed.replace(/^[-*]\s+/, ""));
      if (!bulletText || shouldDropBullet(bulletText)) {
        continue;
      }
      cleanedLines.push(`- ${bulletText}`);
      continue;
    }

    const paragraph = cleanInlineMarkdown(trimmed.replace(/^>\s*/, ""));
    if (paragraph && !shouldDropLine(paragraph)) {
      cleanedLines.push(paragraph);
    }
  }

  return cleanedLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildMarkdownBlocks(markdown: string) {
  const normalized = cleanNoteMarkdownForDisplay(markdown);
  if (!normalized) {
    return [] as MarkdownBlock[];
  }

  const blocks: MarkdownBlock[] = [];
  let currentList: string[] = [];

  function flushList() {
    if (!currentList.length) {
      return;
    }
    blocks.push({ kind: "list", items: currentList });
    currentList = [];
  }

  for (const rawLine of normalized.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      continue;
    }

    if (/^##\s+/.test(line)) {
      flushList();
      blocks.push({ kind: "heading", level: 2, text: line.replace(/^##\s+/, "").trim() });
      continue;
    }

    if (/^###\s+/.test(line)) {
      flushList();
      blocks.push({ kind: "heading", level: 3, text: line.replace(/^###\s+/, "").trim() });
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      currentList.push(line.replace(/^[-*]\s+/, "").trim());
      continue;
    }

    flushList();
    blocks.push({ kind: "paragraph", text: line });
  }

  flushList();
  return blocks;
}

function renderInlineText(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return parts.map((part, index) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) {
      return <strong key={`${part}-${index}`}>{part.slice(2, -2)}</strong>;
    }
    if (/^`[^`]+`$/.test(part)) {
      return <code key={`${part}-${index}`}>{part.slice(1, -1)}</code>;
    }
    return <span key={`${part}-${index}`}>{part}</span>;
  });
}

export default function MarkdownNoteView({ markdown, className }: MarkdownNoteViewProps) {
  const blocks = buildMarkdownBlocks(markdown);

  if (!blocks.length) {
    return <div className={`note-markdown-view${className ? ` ${className}` : ""}`} />;
  }

  return (
    <div className={`note-markdown-view${className ? ` ${className}` : ""}`}>
      {blocks.map((block, index) => {
        if (block.kind === "heading") {
          return block.level === 2 ? (
            <h3 key={`heading-${index}`} className="note-markdown-h2">
              {block.text}
            </h3>
          ) : (
            <h4 key={`subheading-${index}`} className="note-markdown-h3">
              {block.text}
            </h4>
          );
        }

        if (block.kind === "list") {
          return (
            <ul key={`list-${index}`} className="note-markdown-list">
              {block.items.map((item) => (
                <li key={`${index}-${item}`}>{renderInlineText(item)}</li>
              ))}
            </ul>
          );
        }

        return (
          <p key={`paragraph-${index}`} className="note-markdown-paragraph">
            {renderInlineText(block.text)}
          </p>
        );
      })}
    </div>
  );
}
