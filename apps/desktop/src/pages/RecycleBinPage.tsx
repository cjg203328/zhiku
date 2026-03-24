import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { emptyTrash, getTrashContents, permanentDeleteContent, restoreContent } from "../lib/api";
import { useLanguage } from "../lib/language";
import { splitStageDigestText } from "../lib/stageDigest";
import { useAppStore } from "../store/appStore";

export default function RecycleBinPage() {
  const { displayText } = useLanguage();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const showToast = useAppStore((s) => s.showToast);
  const [restoringIds, setRestoringIds] = useState<Set<string>>(new Set());
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());

  const trashQuery = useQuery({ queryKey: ["trash"], queryFn: getTrashContents, retry: 1 });

  const restoreMutation = useMutation({
    mutationFn: async (payload: { id: string; openAfter: boolean }) => {
      await restoreContent(payload.id);
      return payload;
    },
    onMutate: ({ id }) => setRestoringIds((prev) => new Set([...prev, id])),
    onSettled: (_, __, { id }) => setRestoringIds((prev) => { const next = new Set(prev); next.delete(id); return next; }),
    onSuccess: async (payload) => {
      await queryClient.invalidateQueries({ queryKey: ["trash"] });
      await queryClient.invalidateQueries({ queryKey: ["contents"] });
      showToast(payload.openAfter ? "内容已恢复，正在打开详情。" : "内容已恢复到知识库。", "success");
      if (payload.openAfter) navigate(`/library/${payload.id}`);
    },
    onError: () => { showToast("恢复失败，请稍后再试。", "error"); },
  });

  const permanentDeleteMutation = useMutation({
    mutationFn: (id: string) => permanentDeleteContent(id),
    onMutate: (id) => setDeletingIds((prev) => new Set([...prev, id])),
    onSettled: (_, __, id) => setDeletingIds((prev) => { const next = new Set(prev); next.delete(id); return next; }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["trash"] });
      showToast("内容已彻底删除。", "success");
    },
    onError: () => { showToast("彻底删除失败，请稍后再试。", "error"); },
  });

  const emptyMutation = useMutation({
    mutationFn: emptyTrash,
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["trash"] });
      await queryClient.invalidateQueries({ queryKey: ["contents"] });
      showToast(result.deleted > 0 ? `已永久清空 ${result.deleted} 条内容。` : (result.message || "回收站已清空。"), "success");
    },
    onError: () => { showToast("清空失败，请稍后再试。", "error"); },
  });

  function handleEmptyTrash() {
    const total = trashQuery.data?.total ?? 0;
    if (!total || emptyMutation.isPending) return;
    if (!window.confirm(displayText(`确认永久清空回收站中的 ${total} 条内容吗？此操作无法恢复。`))) return;
    emptyMutation.mutate();
  }

  function handlePermanentDelete(id: string, title: string) {
    if (!window.confirm(displayText(`确认彻底删除《${title}》吗？此操作无法恢复。`))) return;
    permanentDeleteMutation.mutate(id);
  }

  const isAnythingPending = emptyMutation.isPending || restoringIds.size > 0 || deletingIds.size > 0;

  function getPlatformGroupLabel(platform: string | null | undefined, sourceType: string | null | undefined) {
    if (platform === "bilibili") return "B站视频";
    if (platform === "local_file" || sourceType === "file") return "本地文件";
    if (platform === "webpage" || sourceType === "webpage") return "网页";
    return "其他来源";
  }

  // Group items by platform/source
  const groupedItems = trashQuery.data?.items.reduce<Record<string, typeof trashQuery.data.items>>((acc, item) => {
    const groupLabel = getPlatformGroupLabel(item.platform, item.source_type);
    if (!acc[groupLabel]) acc[groupLabel] = [];
    acc[groupLabel].push(item);
    return acc;
  }, {}) ?? {};
  const groupOrder = ["B站视频", "本地文件", "网页", "其他来源"];
  const sortedGroups = Object.keys(groupedItems).sort((a, b) => {
    const ai = groupOrder.indexOf(a);
    const bi = groupOrder.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  function renderItemCard(item: NonNullable<typeof trashQuery.data>["items"][number]) {
    const isRestoring = restoringIds.has(item.id);
    const isDeleting = deletingIds.has(item.id);
    const summaryLines = splitStageDigestText(item.summary || "", 2);
    return (
      <article className="card detail-section-card" key={item.id}>
        <div className="pill-row">
          <span className="pill">{displayText(`删除于 ${item.deleted_at ? new Date(item.deleted_at).toLocaleDateString() : "未知"}`)}</span>
        </div>
        <h3>{displayText(item.title)}</h3>
        {summaryLines.length > 0 ? (
          <div className="trash-summary-points">
            {summaryLines.map((line) => (
              <p key={`${item.id}-${line}`}>{displayText(line)}</p>
            ))}
          </div>
        ) : (
          <p className="muted-text">{displayText("当前没有摘要。")}</p>
        )}
        <div className="pill-row">
          {item.tags.map((tag) => (
            <span className="pill" key={tag}>{displayText(tag)}</span>
          ))}
        </div>
        <div className="header-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={() => restoreMutation.mutate({ id: item.id, openAfter: false })}
            disabled={isRestoring || isDeleting || isAnythingPending}
          >
            {isRestoring ? displayText("恢复中...") : displayText("恢复内容")}
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={() => restoreMutation.mutate({ id: item.id, openAfter: true })}
            disabled={isRestoring || isDeleting || isAnythingPending}
          >
            {displayText("恢复并打开")}
          </button>
          <button
            className="danger-button"
            type="button"
            onClick={() => { handlePermanentDelete(item.id, item.title); }}
            disabled={isRestoring || isDeleting || isAnythingPending}
          >
            {isDeleting ? displayText("删除中...") : displayText("彻底删除")}
          </button>
        </div>
      </article>
    );
  }

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">{displayText("回收站")}</p>
          <h2>{displayText("已删除内容")}</h2>
          <p className="muted-text">{displayText("恢复后内容重新回到知识库，彻底删除后无法找回。")}</p>
        </div>
        <div className="header-actions">
          <span className="pill">{displayText(`${trashQuery.data?.total ?? 0} 条`)}</span>
          <button
            className="danger-button"
            type="button"
            onClick={handleEmptyTrash}
            disabled={!trashQuery.data?.total || isAnythingPending}
          >
            {emptyMutation.isPending ? displayText("清空中...") : displayText("清空回收站")}
          </button>
        </div>
      </header>

      {trashQuery.isLoading && <p className="muted-text">{displayText("正在读取回收站...")}</p>}
      {trashQuery.isError && <p className="error-text">{displayText("无法读取回收站，请先确认 API 服务已启动。")}</p>}
      {trashQuery.isSuccess && !trashQuery.data.total && (
        <div style={{ textAlign: "center", padding: "var(--space-8) var(--space-4)" }}>
          <p style={{ fontSize: "2rem", marginBottom: "var(--space-2)" }}>◌</p>
          <p className="muted-text">{displayText("回收站是空的。")}</p>
        </div>
      )}

      {sortedGroups.map((groupLabel) => (
        <section key={groupLabel} className="trash-source-group">
          <div className="trash-source-group-header">
            <span className="eyebrow">{displayText(groupLabel)}</span>
            <span className="pill">{displayText(`${groupedItems[groupLabel].length} 条`)}</span>
          </div>
          <div className="library-grid">
            {groupedItems[groupLabel].map(renderItemCard)}
          </div>
        </section>
      ))}

    </section>
  );
}
