import { useState } from "react";
import { Brain } from "lucide-react";
import { useTypewriter } from "../../hooks/useTypewriter";
import { HighlightedPlainText } from "./HighlightedPlainText";
import styles from "./ThinkingBlock.module.css";
import caretStyles from "./caret.module.css";

interface ThinkingBlockProps {
  content: string;
  isStreaming: boolean;
  enableTypewriter?: boolean;
  inline?: boolean;
  /** When true, the block starts expanded (persisted thinking with the
   *  toolbar Eye on). Live streaming always expands regardless. */
  defaultExpanded?: boolean;
  searchQuery?: string;
}

export function ThinkingBlock({
  content,
  isStreaming,
  enableTypewriter,
  inline = false,
  defaultExpanded = false,
  searchQuery,
}: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(isStreaming || defaultExpanded);
  const label = isStreaming ? "Thinking…" : "Thinking";
  const queryMatches =
    !!searchQuery && content.toLowerCase().includes(searchQuery.toLowerCase());
  const isExpanded = inline || expanded || queryMatches || isStreaming;
  const { displayed, showCaret } = useTypewriter(content, isStreaming, {
    enabled: !!enableTypewriter && isExpanded,
  });

  // Live thinking must still show the "Thinking…" header before the first
  // token. Collapsed-with-no-content used to make the whole stream look empty.
  if (!content && !isStreaming) return null;

  const visibleContent = enableTypewriter ? displayed : content;
  const contentNode = (
    <div className={inline ? `${styles.content} ${styles.contentInline}` : styles.content}>
      {searchQuery ? (
        <HighlightedPlainText text={visibleContent} query={searchQuery} />
      ) : (
        visibleContent
      )}
      {showCaret && <span className={caretStyles.caret} aria-hidden="true" />}
    </div>
  );

  if (inline) {
    return (
      <div className={`${styles.container} ${styles.containerInline}`}>
        <div className={`${styles.header} ${styles.headerInline}`}>
          <Brain size={14} />
          <span className={styles.label}>{label}</span>
        </div>
        {contentNode}
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <button
        className={styles.header}
        onClick={() => setExpanded(!expanded)}
        aria-expanded={isExpanded}
      >
        <span className={`${styles.chevron} ${isExpanded ? styles.chevronExpanded : ""}`}>
          ›
        </span>
        <Brain size={14} />
        <span className={styles.label}>{label}</span>
      </button>
      {isExpanded && contentNode}
    </div>
  );
}
