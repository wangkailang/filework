/** 规划器类型 —— 在 plan-generator、plan-runner 与 IPC 层之间共享。 */

export interface PlanSubStep {
  /** 描述父步骤内某个具体动作的简短标签 */
  label: string;
  /** 该子步骤是否已完成 */
  status: "pending" | "done";
}

export interface PlanStepArtifact {
  /** 工具调用 id */
  toolCallId: string;
  /** 工具名称(如 "writeFile"、"readFile"、"listDirectory") */
  toolName: string;
  /** 工具调用参数 */
  args: Record<string, unknown>;
  /** 工具结果输出(用于展示,已截断) */
  result?: unknown;
  /** 工具调用是否成功 */
  success: boolean;
}

export interface PlanStep {
  /** 顺序步骤 id(从 1 开始) */
  id: number;
  /** 简短动作标签(如 "scan"、"organize"、"report") */
  action: string;
  /** 该步骤所做事情的可读描述 */
  description: string;
  /** 该步骤可选激活的技能 id */
  skillId?: string;
  /** 如何验证该步骤是否成功(如 "listDirectory confirms files moved") */
  verification?: string;
  /** 该步骤内具体动作的拆解 */
  subSteps?: PlanSubStep[];
  /** 执行过程中产出的工件 */
  artifacts?: PlanStepArtifact[];
  /** 执行状态 */
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  /** 执行后的结果摘要(简短,用于上下文传递) */
  resultSummary?: string;
  /** 失败时的错误信息 */
  error?: string;
}

export interface Plan {
  /** 唯一计划 id */
  id: string;
  /** 原始用户提示词 */
  prompt: string;
  /** 规划器生成的高层目标描述 */
  goal: string;
  /** 有序步骤列表 */
  steps: PlanStep[];
  /** 计划整体状态 */
  status:
    | "draft"
    | "approved"
    | "executing"
    | "completed"
    | "failed"
    | "cancelled";
  /** 工作目录路径 */
  workspacePath: string;
  /** ISO 时间戳 */
  createdAt: string;
  /** ISO 时间戳 */
  updatedAt: string;
}

/**
 * 规划阶段期望 LLM 输出的结构化 JSON。
 * 它是 Plan 的子集 —— 其余字段由我们自己填充。
 */
export interface PlannerLLMOutput {
  goal: string;
  steps: Array<{
    action: string;
    description: string;
    skillId?: string;
    subSteps?: string[];
    verify?: string;
  }>;
}
