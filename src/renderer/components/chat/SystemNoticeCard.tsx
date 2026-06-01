import { ShieldCheck } from "lucide-react";

/**
 * 系统提示卡:与模型输出解耦的确定性信号。检测到疑似密钥时由 ChatPanel 渲染,
 * 告知用户已自动遮蔽且不会写入会话记录/记忆——无论模型怎么叙述都不改变这一事实。
 */
export const SystemNoticeCard = ({ message }: { message: string }) => (
  <div className="my-2 flex items-center gap-2 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-400/30 dark:bg-amber-950/40 dark:text-amber-200">
    <ShieldCheck className="size-4 shrink-0" />
    <span>{message}</span>
  </div>
);
