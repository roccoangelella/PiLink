import type {
  CollaborationBoardResult,
  CollaborationParticipantView,
  CollaborationTaskView,
} from "./health.js";

export type CollaborationDashboardStatus = "ready" | "stale" | "error";

export interface CollaborationDashboardState {
  status: CollaborationDashboardStatus;
  tasks: CollaborationTaskView[];
  participants: CollaborationParticipantView[];
  refreshedAt: string;
  sourceTimestamp?: string;
  error?: string;
}

export function updateCollaborationDashboardState(
  previous: CollaborationDashboardState | undefined,
  result: CollaborationBoardResult,
  now = new Date(),
): CollaborationDashboardState {
  const refreshedAt = validDate(now).toISOString();
  if (result.online && result.board?.status === "ready") {
    return {
      status: "ready",
      tasks: result.board.tasks,
      participants: result.board.participants,
      refreshedAt,
      sourceTimestamp: result.board.timestamp,
    };
  }

  const error = result.error || result.board?.error || "Collaboration task board is unavailable";
  if (previous && (previous.status === "ready" || previous.status === "stale")) {
    return {
      ...previous,
      status: "stale",
      refreshedAt,
      error,
    };
  }

  return {
    status: "error",
    tasks: result.board?.tasks || [],
    participants: result.board?.participants || [],
    refreshedAt,
    ...(result.board?.timestamp ? { sourceTimestamp: result.board.timestamp } : {}),
    error,
  };
}

export function taskColumn(
  task: CollaborationTaskView,
  tasks: readonly CollaborationTaskView[],
  now = new Date(),
): "open" | "working" | "blocked" | "done" {
  if (task.status === "working") return "working";
  if (task.status === "input_required") return "blocked";
  if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") return "done";
  if (dependencySummary(task, tasks) !== "Ready") return "blocked";
  if (task.notBefore && Date.parse(task.notBefore) > validDate(now).getTime()) return "blocked";
  return "open";
}

export function dependencySummary(task: CollaborationTaskView, tasks: readonly CollaborationTaskView[]): string {
  if (task.dependencies.length === 0) return "Ready";
  const byId = new Map(tasks.map((candidate) => [candidate.taskId, candidate]));
  const unsatisfied = task.dependencies.filter((dependency) => {
    const candidate = byId.get(dependency.taskId);
    if (!candidate) return true;
    return dependency.condition === "completed"
      ? candidate.status !== "completed"
      : !["completed", "failed", "cancelled"].includes(candidate.status);
  });
  return unsatisfied.length === 0 ? "Ready" : `${unsatisfied.length} blocker${unsatisfied.length === 1 ? "" : "s"}`;
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("now must be a valid Date");
  return value;
}
