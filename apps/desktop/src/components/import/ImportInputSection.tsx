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
      <p className="muted-text">{displayText("自动尝试：字幕 -> 正文 -> 转写")}</p>

      {awaitingImportConfirmation && probeRequiresConfirmation && lastProbedUrl === urlValue.trim() ? (
        <article className="result-callout import-guard-callout">
          <strong>{displayText("这条链接大概率只能先拿到弱材料。")}</strong>
          <p>{displayText("建议先补 Cookie 或转写；如果你只想先建档，再点一次开始导入也可以。")}</p>
        </article>
      ) : null}

      {showAdvanced && (
        <article className="advanced-sheet">
          <div className="section-block">
            <span className="field-label">{displayText("输出风格")}</span>
            <div className="pill-row">
              {[
                { value: "structured", label: "结构化" },
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
            placeholder={displayText("例如：新手引导、产品拆解")}
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
              <>
                <input
                  className="search-input"
                  type="file"
                  onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
                />
                <button
                  className="secondary-button"
                  type="button"
                  disabled={!selectedFile || isImporting}
                  onClick={() => selectedFile && onFileUploadMutate(selectedFile)}
                >
                  {isImporting ? displayText("处理中...") : displayText("上传并解析")}
                </button>
              </>
            )}
          </div>
        </article>
      )}
    </article>
  );
}
