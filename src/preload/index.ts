import { contextBridge, ipcRenderer } from "electron";

/**
 * Expose safe IPC methods to the renderer process via contextBridge.
 * This is the ONLY bridge between main and renderer.
 */
const api = {
  // Dialog
  openDirectory: (defaultPath?: string) => ipcRenderer.invoke("dialog:openDirectory", defaultPath),
  showInFinder: (path: string) => ipcRenderer.invoke("shell:showInFinder", path),

  // File system
  listDirectory: (path: string, depth?: number) =>
    ipcRenderer.invoke("fs:listDirectory", path, depth),
  readFile: (path: string) => ipcRenderer.invoke("fs:readFile", path),
  readFileBase64: (path: string) => ipcRenderer.invoke("fs:readFileBase64", path),
  directoryStats: (path: string) => ipcRenderer.invoke("fs:directoryStats", path),

  // AI
  getAIConfig: () => ipcRenderer.invoke("ai:getConfig"),
  getSkills: () => ipcRenderer.invoke("ai:getSkills"),
  getSuggestions: () => ipcRenderer.invoke("ai:getSuggestions"),
  listSkills: () => ipcRenderer.invoke("ai:listSkills"),
  getSkillDetail: (skillId: string) =>
    ipcRenderer.invoke("ai:getSkillDetail", { skillId }),
  initSkills: (payload: { workspacePath: string; additionalDirs?: string[] }) =>
    ipcRenderer.invoke("ai:initSkills", payload),
  refreshSkills: (workspacePath: string) =>
    ipcRenderer.invoke("ai:refreshSkills", { workspacePath }),
  approveSkill: (payload: { skillId: string; approved: boolean }) =>
    ipcRenderer.invoke("ai:approveSkill", payload),
  executeTask: (payload: {
    prompt: string;
    workspacePath: string;
    llmConfigId?: string;
    history?: Array<{ role: "user" | "assistant"; content: string; parts?: unknown[] }>;
  }) => ipcRenderer.invoke("ai:executeTask", payload),
  stopGeneration: (taskId: string) =>
    ipcRenderer.invoke("ai:stopGeneration", { taskId }),

  // Planner
  checkNeedsPlanning: (payload: { prompt: string }) =>
    ipcRenderer.invoke("ai:checkNeedsPlanning", payload),
  generatePlan: (payload: { prompt: string; workspacePath: string; llmConfigId?: string }) =>
    ipcRenderer.invoke("ai:generatePlan", payload),
  approvePlan: (planId: string) =>
    ipcRenderer.invoke("ai:approvePlan", { planId }),
  rejectPlan: (planId: string) =>
    ipcRenderer.invoke("ai:rejectPlan", { planId }),
  cancelPlan: (planId: string) =>
    ipcRenderer.invoke("ai:cancelPlan", { planId }),

  // Planner streaming events
  onPlanGenerating: (callback: (data: { prompt: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { prompt: string }) =>
      callback(data);
    ipcRenderer.on("ai:plan-generating", handler);
    return () => ipcRenderer.removeListener("ai:plan-generating", handler);
  },
  onPlanReady: (callback: (data: { id?: string; plan: unknown }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { id?: string; plan: unknown }) =>
      callback(data);
    ipcRenderer.on("ai:plan-ready", handler);
    return () => ipcRenderer.removeListener("ai:plan-ready", handler);
  },
  onPlanError: (callback: (data: { id?: string; error: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { id?: string; error: string }) =>
      callback(data);
    ipcRenderer.on("ai:plan-error", handler);
    return () => ipcRenderer.removeListener("ai:plan-error", handler);
  },
  onPlanStepStart: (
    callback: (data: { id: string; planId: string; stepId: number; totalSteps: number }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { id: string; planId: string; stepId: number; totalSteps: number },
    ) => callback(data);
    ipcRenderer.on("ai:plan-step-start", handler);
    return () => ipcRenderer.removeListener("ai:plan-step-start", handler);
  },
  onPlanStepDone: (
    callback: (data: { id: string; planId: string; stepId: number }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { id: string; planId: string; stepId: number },
    ) => callback(data);
    ipcRenderer.on("ai:plan-step-done", handler);
    return () => ipcRenderer.removeListener("ai:plan-step-done", handler);
  },
  onPlanStepError: (
    callback: (data: { id: string; planId: string; stepId: number; error: string }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { id: string; planId: string; stepId: number; error: string },
    ) => callback(data);
    ipcRenderer.on("ai:plan-step-error", handler);
    return () => ipcRenderer.removeListener("ai:plan-step-error", handler);
  },

  // Skill events
  onSkillActivated: (
    callback: (data: { id: string; skillId: string; skillName: string; source: string }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { id: string; skillId: string; skillName: string; source: string },
    ) => callback(data);
    ipcRenderer.on("ai:skill-activated", handler);
    return () => ipcRenderer.removeListener("ai:skill-activated", handler);
  },
  onSkillApprovalRequest: (
    callback: (data: {
      skillId: string;
      sourcePath: string;
      commands: string[];
      hooks: string[];
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { skillId: string; sourcePath: string; commands: string[]; hooks: string[] },
    ) => callback(data);
    ipcRenderer.on("skill:approval-request", handler);
    return () => ipcRenderer.removeListener("skill:approval-request", handler);
  },

  // AI streaming events
  onStreamStart: (callback: (data: { id: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { id: string }) => callback(data);
    ipcRenderer.on("ai:stream-start", handler);
    return () => ipcRenderer.removeListener("ai:stream-start", handler);
  },
  onStreamDelta: (callback: (data: { id: string; delta: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { id: string; delta: string }) =>
      callback(data);
    ipcRenderer.on("ai:stream-delta", handler);
    return () => ipcRenderer.removeListener("ai:stream-delta", handler);
  },
  onStreamToolCall: (
    callback: (data: {
      id: string;
      toolCallId: string;
      toolName: string;
      args: unknown;
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { id: string; toolCallId: string; toolName: string; args: unknown },
    ) => callback(data);
    ipcRenderer.on("ai:stream-tool-call", handler);
    return () => ipcRenderer.removeListener("ai:stream-tool-call", handler);
  },
  onStreamToolResult: (
    callback: (data: {
      id: string;
      toolCallId: string;
      toolName: string;
      result: unknown;
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { id: string; toolCallId: string; toolName: string; result: unknown },
    ) => callback(data);
    ipcRenderer.on("ai:stream-tool-result", handler);
    return () => ipcRenderer.removeListener("ai:stream-tool-result", handler);
  },
  onStreamToolApproval: (
    callback: (data: {
      id: string;
      toolCallId: string;
      toolName: string;
      args: unknown;
      description: string;
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        id: string;
        toolCallId: string;
        toolName: string;
        args: unknown;
        description: string;
      },
    ) => callback(data);
    ipcRenderer.on("ai:stream-tool-approval", handler);
    return () => ipcRenderer.removeListener("ai:stream-tool-approval", handler);
  },
  approveToolCall: (toolCallId: string, approved: boolean) =>
    ipcRenderer.invoke("ai:approveToolCall", { toolCallId, approved }),
  onStreamDone: (callback: (data: { id: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { id: string }) => callback(data);
    ipcRenderer.on("ai:stream-done", handler);
    return () => ipcRenderer.removeListener("ai:stream-done", handler);
  },
  onStreamError: (callback: (data: { id: string; error: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { id: string; error: string }) =>
      callback(data);
    ipcRenderer.on("ai:stream-error", handler);
    return () => ipcRenderer.removeListener("ai:stream-error", handler);
  },

  // Settings
  getSetting: (key: string) => ipcRenderer.invoke("settings:get", key),
  setSetting: (key: string, value: string) => ipcRenderer.invoke("settings:set", key, value),
  getAllSettings: () => ipcRenderer.invoke("settings:getAll"),

  // LLM Config
  llmConfig: {
    list: () => ipcRenderer.invoke("llm-config:list"),
    get: (id: string) => ipcRenderer.invoke("llm-config:get", { id }),
    create: (data: {
      name: string;
      provider: "openai" | "anthropic" | "deepseek" | "ollama" | "custom";
      apiKey?: string;
      baseUrl?: string;
      model: string;
      isDefault?: boolean;
    }) => ipcRenderer.invoke("llm-config:create", data),
    update: (
      id: string,
      data: {
        name?: string;
        provider?: "openai" | "anthropic" | "deepseek" | "ollama" | "custom";
        apiKey?: string;
        baseUrl?: string;
        model?: string;
        isDefault?: boolean;
      },
    ) => ipcRenderer.invoke("llm-config:update", { id, ...data }),
    delete: (id: string) => ipcRenderer.invoke("llm-config:delete", { id }),
  },

  // Workspace history
  getRecentWorkspaces: () => ipcRenderer.invoke("workspace:getRecent"),
  addRecentWorkspace: (path: string, name: string) =>
    ipcRenderer.invoke("workspace:addRecent", path, name),
  removeRecentWorkspace: (path: string) => ipcRenderer.invoke("workspace:removeRecent", path),

  // Chat sessions
  createChatSession: (workspacePath: string, title?: string) =>
    ipcRenderer.invoke("chat:createSession", workspacePath, title),
  getChatSessions: (workspacePath: string) =>
    ipcRenderer.invoke("chat:getSessions", workspacePath),
  updateChatSession: (sessionId: string, updates: { title?: string; updatedAt?: string }) =>
    ipcRenderer.invoke("chat:updateSession", sessionId, updates),
  deleteChatSession: (sessionId: string) =>
    ipcRenderer.invoke("chat:deleteSession", sessionId),

  // Chat history (session-scoped)
  getChatHistory: (sessionId: string) => ipcRenderer.invoke("chat:getHistory", sessionId),
  saveChatHistory: (sessionId: string, workspacePath: string, messages: unknown[]) =>
    ipcRenderer.invoke("chat:saveHistory", sessionId, workspacePath, messages),
};

contextBridge.exposeInMainWorld("filework", api);

export type FileWorkAPI = typeof api;
