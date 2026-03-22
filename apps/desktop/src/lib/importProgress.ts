export type ImportProgressMode = "import" | "reparse";

export type ImportStageItem = {
  key: string;
  label: string;
};

export type ImportStepMeta = {
  label: string;
  description: string;
};

export function isImportJobTerminal(status: string | undefined) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function getImportJobStepMeta(
  step: string | undefined,
  mode: ImportProgressMode = "import",
): ImportStepMeta {
  const isReparse = mode === "reparse";

  if (step === "queued") {
    return isReparse
      ? { label: "已接收任务", description: "当前重整理任务已进入队列。" }
      : { label: "已接收任务", description: "当前导入任务已进入队列。" };
  }

  if (step === "detecting_source") {
    return isReparse
      ? { label: "识别来源", description: "正在确认当前内容的重解析来源，并选择合适的抓取方式。" }
      : { label: "识别来源", description: "正在确认这是视频、网页还是文件，并选择合适的抓取方式。" };
  }

  if (step === "reading_file") {
    return isReparse
      ? { label: "读取文件", description: "正在重新读取原始文件内容，并准备生成新的结构化笔记。" }
      : { label: "读取文件", description: "正在读取文件正文，并准备生成后续的结构化笔记。" };
  }

  if (step === "parsing_content") {
    return isReparse
      ? { label: "提取内容", description: "正在重新整理正文、字幕、截图和可回看的证据层。" }
      : { label: "提取内容", description: "正在整理正文、字幕、截图和可回看的证据层。" };
  }

  if (step === "saving_content") {
    return isReparse
      ? { label: "刷新当前内容", description: "正在保存版本历史，并用新的结果刷新当前内容。" }
      : { label: "整理入库", description: "正在生成笔记、评估质量，并写入知识库。" };
  }

  if (step === "done") {
    return isReparse
      ? { label: "重解析完成", description: "当前内容已刷新完成，可继续阅读或回看。" }
      : { label: "导入完成", description: "内容整理完成，可继续阅读、回看或提问。" };
  }

  if (step === "failed") {
    return isReparse
      ? { label: "重解析失败", description: "当前内容未能完成刷新，可调整后重新提交。" }
      : { label: "导入失败", description: "当前任务未能产出可用内容，可调整后重新提交。" };
  }

  return isReparse
    ? { label: "处理中", description: "系统正在继续整理当前重解析任务。" }
    : { label: "处理中", description: "系统正在继续整理当前导入任务。" };
}

export function getImportStageItems(
  sourceKind?: string,
  mode: ImportProgressMode = "import",
) {
  const savingLabel = mode === "reparse" ? "刷新内容" : "整理入库";

  if (sourceKind === "file" || sourceKind === "file_upload") {
    return [
      { key: "queued", label: "接收任务" },
      { key: "reading_file", label: "读取文件" },
      { key: "parsing_content", label: "提取内容" },
      { key: "saving_content", label: savingLabel },
    ] satisfies ImportStageItem[];
  }

  return [
    { key: "queued", label: "接收任务" },
    { key: "detecting_source", label: "识别来源" },
    { key: "parsing_content", label: "提取内容" },
    { key: "saving_content", label: savingLabel },
  ] satisfies ImportStageItem[];
}

export function resolveImportStageIndex(
  step: string | undefined,
  sourceKind?: string,
  mode: ImportProgressMode = "import",
) {
  const stages = getImportStageItems(sourceKind, mode);
  if (step === "done") return stages.length - 1;
  const index = stages.findIndex((item) => item.key === step);
  return index >= 0 ? index : 0;
}

export function getImportStepShortLabel(step: string | null | undefined) {
  if (step === "queued") return "已进入队列";
  if (step === "detecting_source") return "识别来源";
  if (step === "reading_file") return "读取文件";
  if (step === "parsing_content") return "提取内容";
  if (step === "saving_content") return "整理入库";
  if (step === "done") return "已完成";
  if (step === "failed") return "处理失败";
  return "处理中";
}
