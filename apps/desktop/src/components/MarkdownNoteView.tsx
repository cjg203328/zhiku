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
  "后续优先",
  "当前说明",
  "材料状态",
  "当前材料状态",
  "当前正文来源",
  "粉丝",
  "关注",
  "弹幕",
  "分享",
  "发布时间",
  "上传时间",
];

const DROPPED_SECTION_TITLES = new Set(["可执行建议", "下一步建议"]);
const SECTION_TITLE_ALIASES: Record<string, string> = {
  "快速摘要": "核心结论",
  "问题结论": "核心结论",
  "对用户有用的信息": "精炼正文",
  "可直接参考的信息": "精炼正文",
  "回答整理": "精炼正文",
  "实用整理": "精炼正文",
  "正文整理": "精炼正文",
  "视频笔记": "精炼正文",
  "速记内容": "精炼正文",
  "内容结构": "重点摘录",
  "关键答案": "重点摘录",
  "值得记住的内容": "重点摘录",
  "一句话总结": "核心结论",
};
const CANONICAL_SECTION_TITLES = new Set(["核心结论", "重点摘录", "精炼正文", "原始信息保留"]);
const NOTE_PARAGRAPH_CONNECTOR_PATTERN =
  "(?:那么|然后|但是|不过|所以|因此|另外|同时|接下来|其实|比如|例如|首先|其次|最后|其中|尤其)";

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
  "后续优先",
  "建议下一步",
  "当前说明",
  "已先整理出主题线索",
  "温馨提示",
  "友情提醒",
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

function normalizeReadableChinese(text: string) {
  if (!/[\u4e00-\u9fff]/.test(text)) {
    return text;
  }

  return text
    .replace(/,/g, "，")
    .replace(/;/g, "；")
    .replace(/\?/g, "？")
    .replace(/!/g, "！")
    .replace(/(?<=[\u4e00-\u9fff]):(?=[\u4e00-\u9fffA-Za-z0-9])/g, "：")
    .replace(/\s*([，。！？；：])\s*/g, "$1")
    .replace(/([，。！？；：…])\1+/g, "$1")
    .trim();
}

function looksPromotional(text: string) {
  const normalized = text.replace(/\s+/g, "").toLowerCase();
  if (!normalized) {
    return false;
  }

  const patterns = [
    /(?:点击|记得|欢迎|麻烦|帮忙).{0,8}(?:关注|点赞|收藏|投币|三连)/,
    /(?:评论区|置顶|下方|下边|简介区|简介里).{0,12}(?:链接|领取|查看|获取|报名|课程|资料|福利)/,
    /(?:直播|训练营|社群|粉丝群|知识星球|公众号|私信|加微|微信|vx|qq群|群聊)/,
    /(?:课程介绍|介绍一下.{0,8}课程|报名|优惠|折扣|福利|下单|购买|咨询|预约|体验课|陪跑)/,
    /(?:课程中相见|课程里见|训练营里见|直播间见|下节课见|我们课上见|拜拜)$/,
  ];
  if (patterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  const ctaHits = ["关注", "点赞", "收藏", "投币", "三连", "评论区", "置顶", "下方", "链接", "私信"]
    .filter((token) => normalized.includes(token)).length;
  if (ctaHits >= 2) {
    return true;
  }

  const hasSalesTopic = ["课程", "训练营", "社群", "报名", "优惠", "福利"].some((token) => normalized.includes(token));
  const hasSalesAction = ["链接", "评论区", "置顶", "领取", "咨询", "购买", "下单"].some((token) => normalized.includes(token));
  return hasSalesTopic && hasSalesAction;
}

function normalizeSectionTitle(title: string) {
  return SECTION_TITLE_ALIASES[title] ?? title;
}

function regroupParagraphParts(parts: string[], maxChars = 88) {
  if (!parts.length) {
    return [] as string[];
  }

  const merged: string[] = [];
  let buffer = "";
  for (const part of parts) {
    const candidate = `${buffer}${part}`.trim();
    if (buffer && candidate.length > maxChars) {
      merged.push(buffer.trim());
      buffer = part;
      continue;
    }
    buffer = candidate;
  }

  if (buffer.trim()) {
    merged.push(buffer.trim());
  }
  return merged;
}

function splitReadableParagraphs(text: string) {
  if (!/[\u4e00-\u9fff]/.test(text) || text.length < 72) {
    return [text];
  }

  const sentenceParts = text
    .split(/(?<=[。！？；])/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (sentenceParts.length >= 2) {
    return regroupParagraphParts(sentenceParts);
  }

  const connectorRegex = new RegExp(`(?<=[，；])(?=${NOTE_PARAGRAPH_CONNECTOR_PATTERN})|(?<=\\s)(?=${NOTE_PARAGRAPH_CONNECTOR_PATTERN})`, "g");
  const parts = text
    .replace(connectorRegex, "\n")
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (parts.length <= 1) {
    return [text];
  }

  return regroupParagraphParts(parts);
}

function shouldDropLine(text: string) {
  if (!text) {
    return true;
  }

  if (LOW_SIGNAL_PREFIXES.some((prefix) => text.startsWith(prefix))) {
    return true;
  }

  if (/(?:已通过音频转写恢复正文并保留可回看片段|围绕具体片段继续提问和核对原视频|围绕时间片段继续提问并核对原视频|接入理解模型重整精炼层)/.test(text)) {
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

  if (looksPromotional(text)) {
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
  const seenCanonicalTitles = new Set<string>();
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
      const title = normalizeSectionTitle(cleanInlineMarkdown(trimmed.replace(/^#{2,3}\s+/, "")));
      skippedSection = !title || DROPPED_SECTION_TITLES.has(title);
      if (skippedSection) {
        continue;
      }
      if (CANONICAL_SECTION_TITLES.has(title) && seenCanonicalTitles.has(title)) {
        continue;
      }
      if (CANONICAL_SECTION_TITLES.has(title)) {
        seenCanonicalTitles.add(title);
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
      const bulletText = normalizeReadableChinese(cleanInlineMarkdown(trimmed.replace(/^[-*]\s+/, "")));
      if (!bulletText || shouldDropBullet(bulletText)) {
        continue;
      }
      cleanedLines.push(`- ${bulletText}`);
      continue;
    }

    const paragraph = normalizeReadableChinese(cleanInlineMarkdown(trimmed.replace(/^>\s*/, "")));
    if (paragraph && !shouldDropLine(paragraph)) {
      for (const part of splitReadableParagraphs(paragraph)) {
        if (part && !shouldDropLine(part)) {
          cleanedLines.push(part);
        }
      }
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
