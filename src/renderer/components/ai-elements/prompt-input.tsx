import { type Editor, mergeAttributes, Node as TiptapNode } from "@tiptap/core";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Blocks,
  CornerDownLeftIcon,
  PaperclipIcon,
  SquareIcon,
} from "lucide-react";
import type {
  ChangeEvent,
  ClipboardEventHandler,
  FormEvent,
  HTMLAttributes,
  KeyboardEventHandler,
  TextareaHTMLAttributes,
} from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { AttachmentPart } from "../../../main/core/session/message-parts";
import { useI18nContext } from "../../i18n/i18n-react";
import { cn } from "../../lib/utils";
import {
  filterSkillCommands,
  resolveSkillSlashTextRange,
  SKILL_MENTION_TEXT_MARKER,
  type SkillCommandItem,
} from "../chat/skill-command";
import { textToPromptDoc } from "./rich-prompt-serialization";

// ============================================================================
// 编辑器附件形状 —— 表单的 `attachments` prop。派生自 AttachmentPart,
// 这样在一处重命名字段即可保持单点修改。其他 `ai-elements/*` 已经从
// message-parts 导入(ToolApproval、ApprovalState、PlanView),因此该边界没问题。
// ============================================================================

export type ComposerAttachment = Omit<AttachmentPart, "type">;

// ============================================================================
// Context —— 携带 textarea 的值,使 PromptInput 在提交时能读取它
// ============================================================================

interface PromptInputContextValue {
  value: string;
  setValue: (v: string) => void;
}

const PromptInputContext = createContext<PromptInputContextValue | null>(null);

const readEditorPlainText = (editor: {
  state: {
    doc: {
      content: { size: number };
      textBetween: (
        from: number,
        to: number,
        blockSeparator?: string,
        leafText?: string,
      ) => string;
    };
  };
}) => editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n");

const SkillMention = TiptapNode.create({
  name: "skillMention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      description: { default: "" },
      id: { default: "" },
      name: { default: "" },
      source: { default: "" },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-skill-mention]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const id = String(node.attrs.id ?? "");
    const name = String(node.attrs.name ?? "");
    const description = String(node.attrs.description ?? "");
    const source = String(node.attrs.source ?? "");
    const displayName = name || `/${id}`;
    const title = [displayName, description, source]
      .filter(Boolean)
      .join(" · ");

    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "aria-label": title,
        "data-skill-description": description,
        "data-skill-mention": "",
        "data-skill-id": id,
        "data-skill-name": name,
        "data-skill-source": source,
        class: "prompt-skill-mention",
        title,
      }),
      ["span", { class: "prompt-skill-mention__name" }, displayName],
    ];
  },

  renderText({ node }) {
    const id = String(node.attrs.id ?? "");
    return id ? `/${id}` : "";
  },
});

type SkillSlashRange = {
  query: string;
  from: number;
  to: number;
};

const resolveSkillSlashRange = (editor: Editor): SkillSlashRange | null => {
  const { selection } = editor.state;
  if (!selection.empty) return null;

  const { $from } = selection;
  const textBeforeCursor = $from.parent.textBetween(
    0,
    $from.parentOffset,
    "",
    SKILL_MENTION_TEXT_MARKER,
  );
  const documentTextBeforeCursor = editor.state.doc.textBetween(
    0,
    $from.pos,
    "\n",
    SKILL_MENTION_TEXT_MARKER,
  );
  const nextActive = resolveSkillSlashTextRange({
    documentTextBeforeCursor,
    localTextBeforeCursor: textBeforeCursor,
  });
  if (!nextActive) return null;

  return {
    ...nextActive,
    from: $from.start() + nextActive.from,
    to: $from.pos,
  };
};

// ============================================================================
// PromptInput (root form wrapper)
// ============================================================================

export interface PromptInputMessage {
  text: string;
  attachments?: ComposerAttachment[];
}

export type PromptInputProps = Omit<
  HTMLAttributes<HTMLFormElement>,
  "onSubmit"
> & {
  onSubmit: (message: PromptInputMessage) => void | Promise<void>;
  /**
   * 受控的附件列表 —— 由父组件持有,这样兄弟 DOM 上的拖拽和文件选择器都
   * 写入同一份事实来源。提供该 prop 时,PromptInput 会在提交成功后通过
   * `onAttachmentsChange([])` 清空它。
   */
  attachments?: ComposerAttachment[];
  onAttachmentsChange?: (next: ComposerAttachment[]) => void;
};

export const PromptInput = ({
  className,
  onSubmit,
  children,
  attachments,
  onAttachmentsChange,
  ...props
}: PromptInputProps) => {
  const [value, setValue] = useState("");
  const atts = attachments ?? [];

  const handleSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (!value.trim() && atts.length === 0) return;
      const result = onSubmit({
        text: value,
        attachments: atts.length > 0 ? atts : undefined,
      });
      if (result instanceof Promise) {
        await result;
      }
      setValue("");
      onAttachmentsChange?.([]);
    },
    [value, onSubmit, atts, onAttachmentsChange],
  );

  return (
    <PromptInputContext.Provider value={{ value, setValue }}>
      <form
        className={cn("w-full", className)}
        onSubmit={handleSubmit}
        {...props}
      >
        <div className="surface-sunken relative flex flex-col rounded-lg">
          {children}
        </div>
      </form>
    </PromptInputContext.Provider>
  );
};

// ============================================================================
// PromptInputBody
// ============================================================================

export type PromptInputBodyProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputBody = ({
  className,
  ...props
}: PromptInputBodyProps) => (
  <div className={cn("contents", className)} {...props} />
);

// ============================================================================
// PromptInputTextarea
// ============================================================================

export type PromptInputTextareaProps = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "value"
> & {
  value?: string;
  onChange?: (e: ChangeEvent<HTMLTextAreaElement>) => void;
};

export const PromptInputTextarea = ({
  className,
  placeholder = "What would you like to know?",
  onChange,
  value: externalValue,
  onKeyDown,
  ...props
}: PromptInputTextareaProps) => {
  const ctx = useContext(PromptInputContext);
  const [isComposing, setIsComposing] = useState(false);

  // 将外部值同步到 context,使 PromptInput.handleSubmit 读取到正确的值
  useEffect(() => {
    if (externalValue !== undefined && ctx) {
      ctx.setValue(externalValue);
    }
  }, [externalValue, ctx]);

  const currentValue = externalValue ?? ctx?.value ?? "";

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      ctx?.setValue(e.target.value);
      onChange?.(e);
    },
    [ctx, onChange],
  );

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = useCallback(
    (e) => {
      onKeyDown?.(e);
      if (e.defaultPrevented) return;

      if (e.key === "Enter") {
        if (isComposing || e.nativeEvent.isComposing) return;
        if (e.shiftKey) return;
        e.preventDefault();
        const { form } = e.currentTarget;
        const submitBtn = form?.querySelector(
          'button[type="submit"]',
        ) as HTMLButtonElement | null;
        if (submitBtn?.disabled) return;
        form?.requestSubmit();
      }
    },
    [onKeyDown, isComposing],
  );

  return (
    <textarea
      className={cn(
        "field-sizing-content max-h-48 min-h-16 w-full resize-none bg-transparent px-2 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none",
        className,
      )}
      value={currentValue}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      onCompositionStart={() => setIsComposing(true)}
      onCompositionEnd={() => setIsComposing(false)}
      placeholder={placeholder}
      {...props}
    />
  );
};

// ============================================================================
// PromptInputRichEditor
// ============================================================================

export type PromptInputRichEditorProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  "onChange"
> & {
  value?: string;
  onValueChange?: (value: string) => void;
  onPaste?: ClipboardEventHandler<HTMLDivElement>;
  placeholder?: string;
};

export const PromptInputRichEditor = ({
  className,
  value: externalValue,
  onValueChange,
  onPaste,
  placeholder = "What would you like to know?",
  ...props
}: PromptInputRichEditorProps) => {
  const { LL } = useI18nContext();
  const ctx = useContext(PromptInputContext);
  const currentValue = externalValue ?? ctx?.value ?? "";
  const editorRef = useRef<Editor | null>(null);
  const [skills, setSkills] = useState<SkillCommandItem[]>([]);
  const [skillsFetched, setSkillsFetched] = useState(false);
  const [slashRange, setSlashRange] = useState<SkillSlashRange | null>(null);
  const slashRangeRef = useRef<SkillSlashRange | null>(null);
  const [selectedSkillIndex, setSelectedSkillIndex] = useState(0);
  const selectedSkillIndexRef = useRef(0);
  const filteredSkills = useMemo(
    () => (slashRange ? filterSkillCommands(skills, slashRange.query) : []),
    [skills, slashRange],
  );
  const filteredSkillsRef = useRef<SkillCommandItem[]>([]);

  const syncSlashRange = useCallback((nextEditor: Editor) => {
    const nextRange = resolveSkillSlashRange(nextEditor);
    if (slashRangeRef.current?.query !== nextRange?.query) {
      setSelectedSkillIndex(0);
    }
    setSlashRange(nextRange);
  }, []);

  const insertSkill = useCallback((skill: SkillCommandItem) => {
    const nextEditor = editorRef.current;
    const range = slashRangeRef.current;
    if (!nextEditor || !range) return;

    nextEditor
      .chain()
      .focus()
      .insertContentAt(
        { from: range.from, to: range.to },
        [
          {
            type: "skillMention",
            attrs: {
              description: skill.description,
              id: skill.id,
              name: skill.name,
              source: skill.source,
            },
          },
          { type: "text", text: " " },
        ],
        { updateSelection: true },
      )
      .run();
    setSlashRange(null);
  }, []);
  const insertSkillRef = useRef(insertSkill);

  useEffect(() => {
    slashRangeRef.current = slashRange;
  }, [slashRange]);

  useEffect(() => {
    selectedSkillIndexRef.current = selectedSkillIndex;
  }, [selectedSkillIndex]);

  useEffect(() => {
    filteredSkillsRef.current = filteredSkills;
  }, [filteredSkills]);

  useEffect(() => {
    insertSkillRef.current = insertSkill;
  }, [insertSkill]);

  useEffect(() => {
    if (!slashRange || skillsFetched) return;

    let cancelled = false;
    window.filework
      .listSkills()
      .then((list: SkillCommandItem[]) => {
        if (cancelled) return;
        setSkills(list ?? []);
        setSkillsFetched(true);
      })
      .catch(() => {
        if (cancelled) return;
        setSkills([]);
        setSkillsFetched(true);
      });

    return () => {
      cancelled = true;
    };
  }, [slashRange, skillsFetched]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        codeBlock: false,
        heading: false,
        horizontalRule: false,
      }),
      SkillMention,
      Placeholder.configure({
        placeholder,
        emptyEditorClass: "is-editor-empty",
      }),
    ],
    content: textToPromptDoc(currentValue),
    editorProps: {
      attributes: {
        class: "prompt-input-rich-editor__content",
        "aria-label": placeholder,
      },
      handleKeyDown: (view, event) => {
        const activeSlash = slashRangeRef.current;
        const skillItems = filteredSkillsRef.current;
        if (activeSlash) {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setSelectedSkillIndex(
              (selectedSkillIndexRef.current + 1) %
                Math.max(skillItems.length, 1),
            );
            return true;
          }

          if (event.key === "ArrowUp") {
            event.preventDefault();
            setSelectedSkillIndex(
              selectedSkillIndexRef.current <= 0
                ? Math.max(skillItems.length - 1, 0)
                : selectedSkillIndexRef.current - 1,
            );
            return true;
          }

          if (
            (event.key === "Enter" || event.key === "Tab") &&
            skillItems.length > 0
          ) {
            event.preventDefault();
            insertSkillRef.current(
              skillItems[
                Math.min(selectedSkillIndexRef.current, skillItems.length - 1)
              ],
            );
            return true;
          }

          if (event.key === "Escape") {
            event.preventDefault();
            setSlashRange(null);
            return true;
          }
        }

        if (event.key !== "Enter") return false;
        if (event.shiftKey || event.isComposing || view.composing) return false;

        event.preventDefault();
        const element = view.dom as HTMLElement;
        const form = element.closest("form");
        const submitBtn = form?.querySelector(
          'button[type="submit"]',
        ) as HTMLButtonElement | null;
        if (submitBtn?.disabled) return true;
        form?.requestSubmit();
        return true;
      },
    },
    immediatelyRender: true,
    onUpdate: ({ editor: updatedEditor }) => {
      const nextValue = readEditorPlainText(updatedEditor);
      ctx?.setValue(nextValue);
      onValueChange?.(nextValue);
      syncSlashRange(updatedEditor);
    },
    onSelectionUpdate: ({ editor: updatedEditor }) => {
      syncSlashRange(updatedEditor);
    },
    onBlur: () => {
      setSlashRange(null);
    },
  });

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    if (externalValue !== undefined) {
      ctx?.setValue(externalValue);
    }
  }, [externalValue, ctx]);

  useEffect(() => {
    if (!editor) return;
    const editorValue = readEditorPlainText(editor);
    if (editorValue === currentValue) return;
    editor.commands.setContent(textToPromptDoc(currentValue), {
      emitUpdate: false,
    });
  }, [editor, currentValue]);

  return (
    <div
      className={cn(
        "relative min-h-16 w-full px-2 py-2 text-sm text-foreground",
        className,
      )}
      onPaste={onPaste}
      {...props}
    >
      {slashRange && (
        <div
          className={cn(
            "absolute bottom-full left-0 right-0 z-50 mb-2 overflow-hidden rounded-lg border border-border-strong bg-popover/95 text-popover-foreground shadow-2xl ring-1 ring-border-faint/70 backdrop-blur",
            "max-h-72 overflow-y-auto p-1.5",
          )}
          role="listbox"
        >
          <div className="px-2 pb-1.5 pt-1 text-xs font-medium text-muted-foreground">
            {LL.sidebar_skills()}
          </div>
          {filteredSkills.length === 0 ? (
            <div className="px-2 py-2 text-sm text-muted-foreground">
              {skills.length === 0
                ? LL.skill_loading()
                : slashRange.query
                  ? LL.skill_notFound(slashRange.query)
                  : LL.skill_searchHint()}
            </div>
          ) : (
            filteredSkills.map((skill, index) => {
              const selected = index === selectedSkillIndex;
              return (
                <button
                  key={skill.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                    selected
                      ? "bg-primary/15 text-popover-foreground shadow-[inset_2px_0_0_var(--color-primary)] ring-1 ring-primary/25"
                      : "text-popover-foreground hover:bg-muted/70",
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setSelectedSkillIndex(index)}
                  onClick={() => insertSkill(skill)}
                >
                  <span
                    className={cn(
                      "inline-flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
                      selected
                        ? "border-primary/45 bg-primary/15 text-primary-bright"
                        : "border-border-faint bg-muted text-muted-foreground",
                    )}
                  >
                    <Blocks className="size-3" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{skill.name}</span>
                    {skill.description ? (
                      <span
                        className={cn(
                          "ml-1.5",
                          selected
                            ? "text-popover-foreground/70"
                            : "text-muted-foreground",
                        )}
                      >
                        {skill.description}
                      </span>
                    ) : null}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 text-xs",
                      selected ? "text-primary" : "text-muted-foreground",
                    )}
                  >
                    {skill.source}
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  );
};

// ============================================================================
// PromptInputHeader
// ============================================================================

export type PromptInputHeaderProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputHeader = ({
  className,
  ...props
}: PromptInputHeaderProps) => (
  <div className={cn("flex flex-wrap gap-1 px-3 pt-2", className)} {...props} />
);

// ============================================================================
// PromptInputFooter
// ============================================================================

export type PromptInputFooterProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputFooter = ({
  className,
  ...props
}: PromptInputFooterProps) => (
  <div
    className={cn(
      "flex items-center justify-between gap-1 px-3 py-2",
      className,
    )}
    {...props}
  />
);

// ============================================================================
// PromptInputTools
// ============================================================================

export type PromptInputToolsProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTools = ({
  className,
  ...props
}: PromptInputToolsProps) => (
  <div
    className={cn("flex min-w-0 items-center gap-1", className)}
    {...props}
  />
);

// ============================================================================
// PromptInputSubmit
// ============================================================================

type ChatStatus = "submitted" | "streaming" | "ready" | "error";

export type PromptInputSubmitProps = HTMLAttributes<HTMLButtonElement> & {
  disabled?: boolean;
  status?: ChatStatus;
  onStop?: () => void;
};

export const PromptInputSubmit = ({
  className,
  disabled,
  status,
  onStop,
  ...props
}: PromptInputSubmitProps) => {
  const isActive = status === "submitted" || status === "streaming";

  return (
    <button
      {...props}
      type={isActive ? "button" : "submit"}
      disabled={disabled}
      className={cn(
        "inline-flex items-center justify-center rounded-md p-2 transition-all",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        isActive
          ? "text-muted-foreground hover:bg-accent hover:text-foreground"
          : "bg-primary text-primary-foreground hover:bg-primary-bright active:scale-95",
        className,
      )}
      aria-label={isActive ? "Stop" : "Send"}
      onClick={
        isActive
          ? (e) => {
              e.preventDefault();
              onStop?.();
            }
          : undefined
      }
    >
      {isActive ? (
        <SquareIcon className="size-4 fill-current" />
      ) : (
        <CornerDownLeftIcon className="size-4" />
      )}
    </button>
  );
};

// ============================================================================
// PromptInputAttachButton
// ============================================================================

export type PromptInputAttachButtonProps = HTMLAttributes<HTMLButtonElement> & {
  disabled?: boolean;
};

export const PromptInputAttachButton = ({
  className,
  disabled,
  "aria-label": ariaLabel = "Attach files",
  ...props
}: PromptInputAttachButtonProps) => (
  <button
    type="button"
    {...props}
    disabled={disabled}
    aria-label={ariaLabel}
    className={cn(
      "inline-flex items-center justify-center rounded-md p-2 transition-all active:scale-95",
      "text-muted-foreground hover:text-foreground hover:bg-accent",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
      "disabled:opacity-50 disabled:cursor-not-allowed",
      className,
    )}
  >
    <PaperclipIcon className="size-4" />
  </button>
);
