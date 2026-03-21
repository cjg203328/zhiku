import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import Highlight from "@tiptap/extension-highlight";
import TextAlign from "@tiptap/extension-text-align";
import Placeholder from "@tiptap/extension-placeholder";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { useEffect, useRef, useState } from "react";

interface RichNoteEditorProps {
  content: string;
  editable?: boolean;
  onChange?: (markdown: string) => void;
  onSave?: (markdown: string) => void;
  placeholder?: string;
}

const COLORS = [
  { label: "默认", value: "" },
  { label: "红", value: "#e5484d" },
  { label: "橙", value: "#e6870a" },
  { label: "黄", value: "#c9a800" },
  { label: "绿", value: "#1ab26b" },
  { label: "蓝", value: "#376ee6" },
  { label: "紫", value: "#7c3aed" },
  { label: "灰", value: "#646462" },
];

const HIGHLIGHTS = [
  { label: "无", value: "" },
  { label: "黄", value: "#fff7d1" },
  { label: "蓝", value: "#ddeeff" },
  { label: "绿", value: "#d4f5e4" },
  { label: "粉", value: "#ffe4ee" },
];

const FONT_SIZES = ["12", "13", "14", "15", "16", "18", "20", "24", "28", "32"];

function ToolbarButton({ active, onClick, title, children }: {
  active?: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`rte-btn${active ? " rte-btn-active" : ""}`}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="rte-divider" />;
}

export default function RichNoteEditor({ content, editable = true, onChange, onSave, placeholder }: RichNoteEditorProps) {
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showHighlightPicker, setShowHighlightPicker] = useState(false);
  const [fontSize, setFontSize] = useState("14");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Underline,
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: placeholder ?? "在这里写笔记...", emptyEditorClass: "rte-empty" }),
    ],
    content: content || "",
    editable,
    onUpdate({ editor }) {
      const html = editor.getHTML();
      onChange?.(html);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => onSave?.(html), 1200);
    },
  });

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(editable);
  }, [editor, editable]);

  useEffect(() => {
    if (!editor || !content) return;
    if (editor.getHTML() === content) return;
    editor.commands.setContent(content);
  }, [content, editor]);

  useEffect(() => {
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, []);

  if (!editor) return null;

  function applyFontSize(size: string) {
    setFontSize(size);
    editor?.chain().focus().setMark("textStyle", { fontSize: `${size}px` }).run();
  }

  return (
    <div className={`rte-root${editable ? " rte-editable" : ""}`}>
      {editable && (
        <div className="rte-toolbar">
          {/* 标题 */}
          <select
            className="rte-select"
            value={editor.isActive("heading", { level: 1 }) ? "h1" : editor.isActive("heading", { level: 2 }) ? "h2" : editor.isActive("heading", { level: 3 }) ? "h3" : "p"}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "p") editor.chain().focus().setParagraph().run();
              else editor.chain().focus().toggleHeading({ level: Number(v[1]) as 1|2|3 }).run();
            }}
          >
            <option value="p">正文</option>
            <option value="h1">标题 1</option>
            <option value="h2">标题 2</option>
            <option value="h3">标题 3</option>
          </select>

          {/* 字号 */}
          <select className="rte-select" value={fontSize} onChange={(e) => applyFontSize(e.target.value)}>
            {FONT_SIZES.map((s) => <option key={s} value={s}>{s}px</option>)}
          </select>

          <Divider />

          {/* 粗斜下删 */}
          <ToolbarButton active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()} title="加粗 Ctrl+B">
            <strong>B</strong>
          </ToolbarButton>
          <ToolbarButton active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()} title="斜体 Ctrl+I">
            <em>I</em>
          </ToolbarButton>
          <ToolbarButton active={editor.isActive("underline")} onClick={() => editor.chain().focus().toggleUnderline().run()} title="下划线 Ctrl+U">
            <span style={{ textDecoration: "underline" }}>U</span>
          </ToolbarButton>
          <ToolbarButton active={editor.isActive("strike")} onClick={() => editor.chain().focus().toggleStrike().run()} title="删除线">
            <span style={{ textDecoration: "line-through" }}>S</span>
          </ToolbarButton>

          <Divider />

          {/* 对齐 */}
          <ToolbarButton active={editor.isActive({ textAlign: "left" })} onClick={() => editor.chain().focus().setTextAlign("left").run()} title="左对齐">≡</ToolbarButton>
          <ToolbarButton active={editor.isActive({ textAlign: "center" })} onClick={() => editor.chain().focus().setTextAlign("center").run()} title="居中">≡</ToolbarButton>
          <ToolbarButton active={editor.isActive({ textAlign: "right" })} onClick={() => editor.chain().focus().setTextAlign("right").run()} title="右对齐">≡</ToolbarButton>

          <Divider />

          {/* 列表 */}
          <ToolbarButton active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()} title="无序列表">• —</ToolbarButton>
          <ToolbarButton active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()} title="有序列表">1.</ToolbarButton>
          <ToolbarButton active={editor.isActive("taskList")} onClick={() => editor.chain().focus().toggleTaskList().run()} title="待办列表">☐</ToolbarButton>

          <Divider />

          {/* 引用 / 代码 */}
          <ToolbarButton active={editor.isActive("blockquote")} onClick={() => editor.chain().focus().toggleBlockquote().run()} title="引用块">&ldquo;</ToolbarButton>
          <ToolbarButton active={editor.isActive("code")} onClick={() => editor.chain().focus().toggleCode().run()} title="行内代码">`</ToolbarButton>
          <ToolbarButton active={editor.isActive("codeBlock")} onClick={() => editor.chain().focus().toggleCodeBlock().run()} title="代码块">{"</>"}</ToolbarButton>

          <Divider />

          {/* 文字颜色 */}
          <div className="rte-picker-wrap">
            <ToolbarButton active={showColorPicker} onClick={() => { setShowColorPicker((v) => !v); setShowHighlightPicker(false); }} title="文字颜色">
              A
            </ToolbarButton>
            {showColorPicker && (
              <div className="rte-color-panel">
                {COLORS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    className="rte-color-dot"
                    title={c.label}
                    style={{ background: c.value || "var(--text-primary)", outline: editor.isActive("textStyle", { color: c.value }) ? "2px solid var(--accent)" : undefined }}
                    onClick={() => { c.value ? editor.chain().focus().setColor(c.value).run() : editor.chain().focus().unsetColor().run(); setShowColorPicker(false); }}
                  />
                ))}
              </div>
            )}
          </div>

          {/* 高亮背景 */}
          <div className="rte-picker-wrap">
            <ToolbarButton active={showHighlightPicker} onClick={() => { setShowHighlightPicker((v) => !v); setShowColorPicker(false); }} title="高亮背景">
              <span style={{ background: "#fff7d1", padding: "0 3px", borderRadius: 2 }}>H</span>
            </ToolbarButton>
            {showHighlightPicker && (
              <div className="rte-color-panel">
                {HIGHLIGHTS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    className="rte-color-dot"
                    title={c.label}
                    style={{ background: c.value || "var(--bg-elevated)", border: "1.5px solid var(--border-soft)" }}
                    onClick={() => { c.value ? editor.chain().focus().setHighlight({ color: c.value }).run() : editor.chain().focus().unsetHighlight().run(); setShowHighlightPicker(false); }}
                  />
                ))}
              </div>
            )}
          </div>

          <Divider />

          {/* 撤销重做 */}
          <ToolbarButton onClick={() => editor.chain().focus().undo().run()} title="撤销 Ctrl+Z">↩</ToolbarButton>
          <ToolbarButton onClick={() => editor.chain().focus().redo().run()} title="重做 Ctrl+Y">↪</ToolbarButton>
        </div>
      )}
      <EditorContent editor={editor} className="rte-content" />
    </div>
  );
}
