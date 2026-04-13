/**
 * Usage Tracking IPC Handlers
 *
 * Provides token usage statistics and cost estimation queries.
 */

import { ipcMain } from "electron";
import { getTasks } from "../db";

/**
 * Register usage-related IPC handlers
 */
export const registerUsageHandlers = () => {
	// Get usage for a specific task
	ipcMain.handle(
		"usage:getTaskUsage",
		async (_event, payload: { taskId: string }) => {
			const tasks = getTasks();
			const task = tasks.find((t) => t.id === payload.taskId);
			if (!task) return null;
			return {
				inputTokens: task.inputTokens ?? null,
				outputTokens: task.outputTokens ?? null,
				totalTokens: task.totalTokens ?? null,
				modelId: task.modelId ?? null,
				provider: task.provider ?? null,
			};
		},
	);

	// Get aggregate usage statistics
	ipcMain.handle(
		"usage:getAggregateUsage",
		async (
			_event,
			payload: { from?: string; to?: string; provider?: string },
		) => {
			const allTasks = getTasks();

			const filtered = allTasks.filter((t) => {
				if (t.status !== "completed") return false;
				if (t.totalTokens == null) return false;
				if (payload.from && t.createdAt < payload.from) return false;
				if (payload.to && t.createdAt > payload.to) return false;
				if (payload.provider && t.provider !== payload.provider) return false;
				return true;
			});

			let totalInput = 0;
			let totalOutput = 0;
			let totalTokens = 0;
			const byProvider: Record<
				string,
				{
					inputTokens: number;
					outputTokens: number;
					totalTokens: number;
					taskCount: number;
				}
			> = {};
			const byModel: Record<
				string,
				{
					inputTokens: number;
					outputTokens: number;
					totalTokens: number;
					taskCount: number;
				}
			> = {};

			for (const t of filtered) {
				const inp = t.inputTokens ?? 0;
				const out = t.outputTokens ?? 0;
				const tot = t.totalTokens ?? 0;
				totalInput += inp;
				totalOutput += out;
				totalTokens += tot;

				const prov = t.provider ?? "unknown";
				if (!byProvider[prov])
					byProvider[prov] = {
						inputTokens: 0,
						outputTokens: 0,
						totalTokens: 0,
						taskCount: 0,
					};
				byProvider[prov].inputTokens += inp;
				byProvider[prov].outputTokens += out;
				byProvider[prov].totalTokens += tot;
				byProvider[prov].taskCount++;

				const mod = t.modelId ?? "unknown";
				if (!byModel[mod])
					byModel[mod] = {
						inputTokens: 0,
						outputTokens: 0,
						totalTokens: 0,
						taskCount: 0,
					};
				byModel[mod].inputTokens += inp;
				byModel[mod].outputTokens += out;
				byModel[mod].totalTokens += tot;
				byModel[mod].taskCount++;
			}

			return {
				totalInput,
				totalOutput,
				totalTokens,
				taskCount: filtered.length,
				byProvider,
				byModel,
			};
		},
	);

	// Get recent tasks with usage data
	ipcMain.handle(
		"usage:getRecentUsage",
		async (_event, payload: { limit?: number }) => {
			const limit = payload?.limit ?? 20;
			const allTasks = getTasks();

			return allTasks
				.filter((t) => t.totalTokens != null)
				.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
				.slice(0, limit)
				.map((t) => ({
					id: t.id,
					prompt: t.prompt.slice(0, 100),
					status: t.status,
					createdAt: t.createdAt,
					completedAt: t.completedAt,
					inputTokens: t.inputTokens,
					outputTokens: t.outputTokens,
					totalTokens: t.totalTokens,
					modelId: t.modelId,
					provider: t.provider,
				}));
		},
	);
};
