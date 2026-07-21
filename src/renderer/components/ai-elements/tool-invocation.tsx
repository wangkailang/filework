import type { ReactNode } from "react";
import type { ToolPart } from "../../../main/core/session/message-parts";
import { useI18nContext } from "../../i18n/i18n-react";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "./tool";
import { toolPresenters } from "./tool-presenters";

export interface ToolInvocationProps {
  part: ToolPart;
  workspacePath?: string;
  dense?: boolean;
  /** Optional content owned by the caller, such as the main agent's approval UI. */
  bodyAddon?: ReactNode;
  /** Lets specialized containers add context while retaining the shared tool body. */
  summaryOverride?: ReactNode;
}

/** Shared tool rendering used by both main-agent messages and sub-agent traces. */
export function ToolInvocation({
  part,
  workspacePath,
  dense,
  bodyAddon,
  summaryOverride,
}: ToolInvocationProps) {
  const { LL } = useI18nContext();
  const presenter = toolPresenters[part.toolName];
  const presenterCtx = {
    LL,
    workspacePath,
    toolCallId: part.toolCallId,
    previewSnapshot: part.previewSnapshot,
  };
  const presenterSummary =
    summaryOverride === undefined
      ? presenter?.summary?.(part.args, part.result, part.state, presenterCtx)
      : null;
  const summary =
    summaryOverride === undefined ? presenterSummary : summaryOverride;
  const customInput = presenter?.input?.(part.args, presenterCtx);
  const customOutput =
    part.state === "output-available"
      ? presenter?.output?.(part.result, part.args, part.state, presenterCtx)
      : null;
  const rowAction = presenter?.rowAction?.(part.args, presenterCtx) ?? null;
  const forceBody =
    part.state === "output-error" || !!part.approval || bodyAddon != null;
  const collapsible =
    forceBody ||
    (presenter?.expandable
      ? presenter.expandable(part.args, part.result, part.state, presenterCtx)
      : true);
  const resultText =
    typeof part.result === "string"
      ? part.result
      : JSON.stringify(part.result, null, 2);

  return (
    <Tool
      defaultOpen={false}
      forceOpen={part.approval?.state === "approval-requested"}
    >
      <ToolHeader
        toolName={part.toolName}
        state={part.state}
        summary={summary}
        dense={dense}
        collapsible={collapsible}
        action={rowAction}
      />
      {collapsible && (
        <ToolContent>
          {presenter ? customInput : <ToolInput input={part.args} />}
          {bodyAddon}
          {part.state === "output-available" &&
            (customOutput ?? (
              <ToolOutput
                output={
                  <pre className="font-mono whitespace-pre-wrap break-all">
                    {resultText}
                  </pre>
                }
              />
            ))}
          {part.state === "output-error" && (
            <ToolOutput errorText={resultText} />
          )}
        </ToolContent>
      )}
    </Tool>
  );
}
