import { useCallback, useState } from "react";
import { useLanguage } from "../../lib/language";

type Props = {
  urlValue: string;
  setUrlValue: (v: string) => void;
  onUrlChange: () => void;
  noteStyle: string;
  setNoteStyle: (v: string) => void;
  summaryFocus: string;
  setSummaryFocus: (v: string) => void;
  showAdvanced: boolean;
  setShowAdvanced: (fn: (prev: boolean) => boolean) => void;
  awaitingImportConfirmation: boolean;
  probeRequiresConfirmation: boolean;
  lastProbedUrl: string;
  isImporting: boolean;
  isProbePending: boolean;
  isUrlPending: boolean;
  desktopRuntime: boolean;
  filePathValue: string;
  setFilePathValue: (v: string) => void;
  selectedFile: File | null;
  setSelectedFile: (f: File | null) => void;
  onProbe: () => void;
  onUrlImportStart: () => void;
  onFileMutate: (path: string) => void;
  onFileUploadMutate: (file: File) => void;
};

function FileDropZone({
  selectedFile, setSelectedFile, isImporting, onFileUploadMutate, displayText,
}: {
  selectedFile: File | null;
  setSelectedFile: (f: File | null) => void;
  isImporting: boolean;
  onFileUploadMutate: (file: File) => void;
  displayText: (s: string) => string;
}) {
  const { isDragging, onDragOver, onDragLeave, onDrop } = useDragDrop(setSelectedFile);
  return (
    <div
      className={`file-dropzone${isDragging ? " file-dropzone--active" : ""}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <label className="file-dropzone__label">
        {selectedFile
          ? <span className="file-dropzone__name">{selectedFile.name}</span>
          : <span>{isDragging ? displayText("释放以选择文件") : displayText("拖拽文件到此处，或点击选择")}</span>
        }
        <input
          type="file"
          className="file-dropzone__input"
          onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
        />
      </label>
      {selectedFile && (
        <button
          className="secondary-button"
          type="button"
          disabled={isImporting}
          onClick={() => onFileUploadMutate(selectedFile)}
        >
          {isImporting ? displayText("处理中...") : displayText("上传并解析")}
        </button>
      )}
    </div>
  );
}

function useDragDrop(onFileDrop: (file: File) => void) {
  const [isDragging, setIsDragging] = useState(false);
  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);
  const onDragLeave = useCallback(() => setIsDragging(false), []);
  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) onFileDrop(file);
  }, [onFileDrop]);
  return { isDragging, onDragOver, onDragLeave, onDrop };
}

export default function ImportInputSection({
  urlValue, setUrlValue, onUrlChange,
  noteStyle, setNoteStyle,
  summaryFocus, setSummaryFocus,
  showAdvanced, setShowAdvanced,
  awaitingImportConfirmation, probeRequiresConfirmation, lastProbedUrl,
  isImporting, isProbePending, isUrlPending,
  desktopRuntime,
  filePathValue, setFilePathValue,
  selectedFile, setSelectedFile,
  onProbe, onUrlImportStart, onFileMutate, onFileUploadMutate,
}: Props) {
  const { displayText } = useLanguage();
  const isBilibiliLink = (value: string) => /bilibili\.com|b23\.tv|BV[0-9A-Za-z]+/i.test(value.trim());

  return (
    <article className="import-card-primary smart-import-main">
      <label className="field-label" htmlFor="url-input">{displayText("粘贴链接")}</label>
      <input
        id="url-input"
        className="search-input smart-import-input"
        placeholder={displayText("例如：https://www.bilibili.com/video/BV...")}
        value={urlValue}
        onChange={(event) => {
          setUrlValue(event.target.value);
          onUrlChange();
        }}
      />
      <div className="header-actions">
        <button
          className="secondary-button"
          type="button"
          disabled={!urlValue.trim() || !isBilibiliLink(urlValue) || isProbePending || isImporting}
          onClick={onProbe}
        >
          {isProbePending ? displayText("预检中...") : displayText("预检")}
        </button>
        <button
          className="primary-button"
          type="button"
          disabled={!urlValue.trim() || isImporting || isProbePending}
          onClick={onUrlImportStart}
        >
          {isImporting ? displayText("处理中...") : displayText("开始导入")}
        </button>
        <button className="secondary-button" type="button" onClick={() => setShowAdvanced((c) => !c)}>
          {showAdvanced ? displayText("收起选项") : displayText("更多选项")}
        </button>
      </div>

      {awaitingImportConfirmation && probeRequiresConfirmation && lastProbedUrl === urlValue.trim() ? (
        <article className="result-callout import-guard-callout">
          <strong>{displayText("这条内容可能只有基础结果。")}</strong>
        </article>
      ) : null}

      {showAdvanced && (
        <article className="advanced-sheet">
          <div className="section-block">
            <span className="field-label">{displayText("输出风格")}</span>
            <div className="pill-row">
              {[
                { value: "structured", label: "结构化" },
                { value: "bilinote", label: "阅读版" },
                { value: "qa", label: "问答导向" },
                { value: "brief", label: "精简速记" },
              ].map((item) => (
                <button
                  key={item.value}
                  className={noteStyle === item.value ? "primary-button" : "secondary-button"}
                  type="button"
                  onClick={() => setNoteStyle(item.value)}
                >
                    {displayText(item.label)}
                </button>
            ))}
            </div>
          </div>

          <label className="field-label" htmlFor="summary-focus-input">{displayText("特别关注")}</label>
          <input
            id="summary-focus-input"
            className="search-input"
            placeholder={displayText("例如：产品拆解、运营策略")}
            value={summaryFocus}
            onChange={(event) => setSummaryFocus(event.target.value)}
          />

          <div className="section-block smart-file-block">
            <h4>{displayText("文件导入")}</h4>
            {desktopRuntime ? (
              <>
                <input
                  className="search-input"
                  placeholder={displayText("例如：D:\\资料\\访谈纪要.docx")}
                  value={filePathValue}
                  onChange={(event) => setFilePathValue(event.target.value)}
                />
                <button
                  className="secondary-button"
                  type="button"
                  disabled={!filePathValue.trim() || isImporting}
                  onClick={() => onFileMutate(filePathValue.trim())}
                >
                  {isImporting ? displayText("处理中...") : displayText("按路径导入")}
                </button>
              </>
            ) : (
              <FileDropZone
                selectedFile={selectedFile}
                setSelectedFile={setSelectedFile}
                isImporting={isImporting}
                onFileUploadMutate={onFileUploadMutate}
                displayText={displayText}
              />
            )}
          </div>
        </article>
      )}
    </article>
  );
}
