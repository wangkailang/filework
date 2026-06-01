import { Lock } from "lucide-react";

/**
 * 系统提示:与模型输出解耦的确定性信号。检测到疑似密钥时由 ChatPanel 渲染,
 * 告知用户已自动遮蔽——无论模型怎么叙述都不改变这一事实。
 *
 * 刻意做成「轻微提醒」:居中、小号、灰阶、无边框背景,不抢占对话视觉重心。
 */
export const SystemNoticeCard = ({ message }: { message: string }) => (
  <div className="my-1 flex items-center justify-center gap-1.5 text-xs text-muted-foreground/70">
    <Lock className="size-3 shrink-0" />
    <span>{message}</span>
  </div>
);
