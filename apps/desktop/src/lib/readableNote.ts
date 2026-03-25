function chunkLongChineseRun(text: string, chunkSize = 30) {
  const chunks = text.match(new RegExp(`.{1,${chunkSize}}`, "g")) ?? [text];
  return chunks
    .map((chunk, index) => {
      const cleaned = chunk.trim();
      if (!cleaned) return "";
      if (/[，。！？；]$/.test(cleaned)) {
        return cleaned;
      }
      return `${cleaned}${index === chunks.length - 1 ? "。" : "，"}`;
    })
    .join("");
}

function restoreReadableChinesePunctuation(text: string) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact || compact.length < 28) {
    return compact;
  }

  const punctuationDensity = (compact.match(/[，。！？；：、“”]/g)?.length ?? 0) / Math.max(compact.length, 1);
  if (punctuationDensity >= 0.014) {
    return compact;
  }

  let repaired = compact
    .replace(/(?<=[\u4e00-\u9fffA-Za-z0-9）】」])(?=(?:但是|不过|然而|所以|因此|另外|同时|接下来|随后|最后|总之|换句话说|这也说明|这意味着))/g, "。")
    .replace(/(?<=[\u4e00-\u9fffA-Za-z0-9）】」])(?=(?:而是|因为|如果|并且|而且|其中|尤其|比如|例如))/g, "，")
    .replace(/(?<=[\u4e00-\u9fffA-Za-z0-9）】」])(?=(?:它|这|那|今年|现在|随后|接着|再往后|这就是|问题是|更重要的是|核心在于))/g, "。");

  const commaParts = repaired.split(/(?<=[，；])/).map((item) => item.trim()).filter(Boolean);
  if (commaParts.length >= 3 && repaired.length >= 96 && (repaired.match(/[。！？；]/g)?.length ?? 0) === 0) {
    const grouped: string[] = [];
    let buffer = "";
    for (const part of commaParts) {
      const normalizedPart = part.replace(/^[，；、]+/, "").trim();
      if (!normalizedPart) continue;
      const candidate = !buffer
        ? normalizedPart
        : buffer.endsWith("，") || buffer.endsWith("；")
          ? `${buffer}${normalizedPart}`
          : `${buffer}，${normalizedPart}`;
      if (buffer && candidate.length > 72) {
        grouped.push(`${buffer.replace(/[，；、]+$/g, "").trimEnd()}。`);
        buffer = normalizedPart;
        continue;
      }
      buffer = candidate;
    }
    if (buffer) {
      grouped.push(`${buffer.replace(/[，；、]+$/g, "").trimEnd()}。`);
    }
    repaired = grouped.join("");
  }

  if ((repaired.match(/[。！？；]/g)?.length ?? 0) === 0 && repaired.length >= 72) {
    repaired = chunkLongChineseRun(repaired);
  }
  return repaired;
}

export function normalizeReadableChinese(text: string) {
  if (!/[\u4e00-\u9fff]/.test(text)) {
    return text.replace(/\s+/g, " ").trim();
  }

  return restoreReadableChinesePunctuation(
    text
      .replace(/,/g, "，")
      .replace(/;/g, "；")
      .replace(/\?/g, "？")
      .replace(/!/g, "！")
      .replace(/(?<=[\u4e00-\u9fff]):(?=[\u4e00-\u9fffA-Za-z0-9])/g, "：")
      .replace(/\s+/g, " ")
      .trim(),
  )
    .replace(/\s*([，。！？；：、])\s*/g, "$1")
    .replace(/([，。！？；：…])\1+/g, "$1")
    .trim();
}

export function splitReadableSentences(text: string, hardCap = 74) {
  const normalized = normalizeReadableChinese(text);
  const baseParts = normalized.split(/(?<=[。！？；])/).map((item) => item.trim()).filter(Boolean);
  if (!baseParts.length) {
    return [] as string[];
  }

  const connectorPattern =
    /(?<=[\u4e00-\u9fffA-Za-z0-9）】」])(?=(?:但是|不过|然而|所以|因此|另外|同时|接下来|随后|最后|总之|换句话说|这也说明|这意味着|首先|其次|其中|尤其|比如|例如|其实|现在|这就是|问题是|更重要的是))/;

  return baseParts.flatMap((part) => {
    if (part.length <= hardCap) {
      return [part];
    }

    const terminal = /[。！？；]$/.test(part) ? part.slice(-1) : "。";
    const body = /[。！？；]$/.test(part) ? part.slice(0, -1).trim() : part;
    const clauses = body
      .split(/(?<=[，；])/)
      .flatMap((item) => item.split(connectorPattern))
      .map((item) => item.trim())
      .filter(Boolean);

    if (clauses.length <= 1) {
      return [chunkLongChineseRun(body)];
    }

    const sentences: string[] = [];
    let buffer = "";
    for (const clause of clauses) {
      const normalizedClause = clause.replace(/^[，；、]+/, "").trim();
      if (!normalizedClause) continue;
      const candidate = !buffer
        ? normalizedClause
        : buffer.endsWith("，") || buffer.endsWith("；")
          ? `${buffer}${normalizedClause}`
          : `${buffer}，${normalizedClause}`;
      if (buffer && candidate.length > hardCap) {
        sentences.push(`${buffer.replace(/[，；、]+$/g, "").trimEnd()}。`);
        buffer = normalizedClause;
        continue;
      }
      buffer = candidate;
    }
    if (buffer) {
      sentences.push(`${buffer.replace(/[，；、]+$/g, "").trimEnd()}${terminal}`);
    }
    return sentences;
  });
}

function regroupParagraphParts(parts: string[], maxChars = 92) {
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

export function splitReadableParagraphs(text: string) {
  const normalized = normalizeReadableChinese(text);
  if (!/[\u4e00-\u9fff]/.test(normalized) || normalized.length < 72) {
    return normalized ? [normalized] : [];
  }

  const sentenceParts = splitReadableSentences(normalized);
  if (sentenceParts.length >= 2) {
    return regroupParagraphParts(sentenceParts);
  }

  const connectorRegex = /(?<=[，；])(?=(?:那么|然后|但是|不过|所以|因此|另外|同时|接下来|其实|比如|例如|首先|其次|最后|其中|尤其))/g;
  const parts = normalized
    .replace(connectorRegex, "\n")
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (parts.length <= 1) {
    return [normalized];
  }
  return regroupParagraphParts(parts);
}

export function prepareReadableNoteMarkdown(markdown: string) {
  if (!markdown.trim()) {
    return "";
  }

  return markdown
    .replace(/\r\n/g, "\n")
    .split("\n")
    .flatMap((rawLine) => {
      const trimmed = rawLine.trim();
      if (!trimmed) {
        return [""];
      }
      if (/^#{1,6}\s+/.test(trimmed) || /^[-*]\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed) || /^!\[/.test(trimmed)) {
        return [rawLine];
      }
      return splitReadableParagraphs(trimmed);
    })
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
