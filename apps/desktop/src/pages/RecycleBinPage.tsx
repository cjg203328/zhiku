import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { emptyTrash, getTrashContents, permanentDeleteContent, restoreContent } from "../lib/api";
import { useLanguage } from "../lib/language";

export default function RecycleBinPage() {
  const { displayText } = useLanguage();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [pageMessage, setPageMessage] = useState("");
  const [pageError, setPageError] = useState("");
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
      setPageError("");
      setPageMessage(payload.openAfter ? "内容已恢复，正在打开详情。" : "内容已恢复到知识库。");
      if (payload.openAfter) navigate(`/library/${payload.id}`);
    },
    onError: () => { setPageMessage(""); setPageError("恢复失败，请稍后再试。"); },
  });

  const permanentDeleteMutation = useMutation({
    mutationFn: (id: string) => permanentDeleteContent(id),
    onMutate: (id) => setDeletingIds((prev) => new Set([...prev, id])),
    onSettled: (_, __, id) => setDeletingIds((prev) => { const next = new Set(prev); next.delete(id); return next; }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["trash"] });
      setPageError("");
      setPageMessage("内容已彻底删除。");
    },
    onError: () => { setPageMessage(""); setPageError("彻底删除失败，请稍后再试。"); },
  });

  const emptyMutation = useMutation({
    mutationFn: emptyTrash,
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["trash"] });
      await queryClient.invalidateQueries({ queryKey: ["contents"] });
      setPageError("");
      setPageMessage(result.deleted > 0 ? `已永久清空 ${result.deleted} 条内容。` : result.message);
    },
    onError: () => { setPageMessage(""); setPageError("清空失败，请稍后再试。"); },
  });

  function handleEmptyTrash() {
    const total = trashQuery.data?.total ?? 0;
    if (!total || emptyMutation.isPending) return;
    if (!window.confirm(displayText(`确认永久清空回收站中的 ${total} 条内容吗？此操作无法恢复。`))) return;
    setPageMessage("");
    setPageError("");
    emptyMutation.mutate();
  }

  function handlePermanentDelete(id: string, title: string) {
    if (!window.confirm(displayText(`确认彻底删除《${title}》吗？此操作无法恢复。`))) return;
    setPageMessage("");
    setPageError("");
    permanentDeleteMutation.mutate(id);
  }

  const isAnythingPending = emptyMutation.isPending || restoringIds.size > 0 || deletingIds.size > 0;

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

      <div className="library-grid">
        {trashQuery.data?.items.map((item) => {
          const isRestoring = restoringIds.has(item.id);
          const isDeleting = deletingIds.has(item.id);
          return (
            <article className="card detail-section-card" key={item.id}>
              <div className="pill-row">
                <span className="pill">{displayText(item.platform ?? item.source_type ?? "未知来源")}</span>
                <span className="pill">{displayText(`删除于 ${item.deleted_at}`)}</span>
              </div>
              <h3>{displayText(item.title)}</h3>
              <p className="muted-text">{displayText(item.summary || "当前没有摘要。")}</p>
              <div className="pill-row">
                {item.tags.map((tag) => (
                  <span className="pill" key={tag}>{displayText(tag)}</span>
                ))}
              </div>
              <div className="header-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => { setPageMessage(""); setPageError(""); restoreMutation.mutate({ id: item.id, openAfter: false }); }}
                  disabled={isRestoring || isDeleting || isAnythingPending}
                >
                  {isRestoring ? displayText("恢复中...") : displayText("恢复内容")}
                </button>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => { setPageMessage(""); setPageError(""); restoreMutation.mutate({ id: item.id, openAfter: true }); }}
                  disabled={isRestoring || isDeleting || isAnythingPending}
                >
                  {displayText("恢复并打开")}
                </button>
                <button
                  className="danger-button"
                  type="button"
                  onClick={() => handlePermanentDelete(item.id, item.title)}
                  disabled={isRestoring || isDeleting || isAnythingPending}
                >
                  {isDeleting ? displayText("删除中...") : displayText("彻底删除")}
                </button>
              </div>
            </article>
          );
        })}
      </div>

      {pageMessage && <p className="success-text">{displayText(pageMessage)}</p>}
      {pageError && <p className="error-text">{displayText(pageError)}</p>}
    </section>
  );
}
