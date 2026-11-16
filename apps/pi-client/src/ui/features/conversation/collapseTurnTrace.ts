import type { AgentTurnView, CustomMessageView, ReasoningActivityView, ToolActivityView } from "$shared/model/conversationModel";

type TurnStep = ReasoningActivityView | ToolActivityView;

/** One folded run of consecutive tool calls and reasoning in the focus view. */
export interface TurnStepGroup {
  /** The first step's id: stable while the run grows, so an opened group stays open. */
  id: string;
  /** Tool calls and reasoning in the run; extension messages folded with them are not steps. */
  steps: number;
  errors: number;
  /** The run still has a step in progress. */
  active: boolean;
  /** What the run did, or is doing right now when active. */
  detail: string;
}

export type TurnItemPlan =
  | { mode: "flat" }
  | {
      mode: "grouped";
      /** Group shown in front of the item with this id. */
      groupsByFirstItemId: ReadonlyMap<string, TurnStepGroup>;
      /** Group id of every folded item. */
      groupIdByItemId: ReadonlyMap<string, string>;
    };

/** A lone step is already a single collapsed row; folding it would only hide its name. */
const MIN_GROUP_STEPS = 2;
const MAX_GROUP_DETAIL_KINDS = 4;
const MAX_STEP_LABEL_LENGTH = 72;

/**
 * Folding is per run, never per turn: each run of consecutive tool calls and reasoning
 * becomes one row, and every reply, including those between runs, stays visible. A
 * running turn folds in the focus view; a finished one also when `collapseTurnTrace`
 * is on, which is the default.
 *
 * An extension's custom message that arrives during a run, such as a background
 * process reporting that it finished, folds into the run instead of ending it:
 * otherwise each one would cut the run into small groups.
 */
export function planTurnItems(
  turn: Pick<AgentTurnView, "status" | "items">,
  collapseTurnTrace: boolean,
  focusView = false,
): TurnItemPlan {
  const fold = turn.status === "running" ? focusView : collapseTurnTrace || focusView;
  return fold ? planStepGroups(turn) : { mode: "flat" };
}

function planStepGroups(turn: Pick<AgentTurnView, "status" | "items">): TurnItemPlan {
  const groupsByFirstItemId = new Map<string, TurnStepGroup>();
  const groupIdByItemId = new Map<string, string>();
  let run: Array<TurnStep | CustomMessageView> = [];

  const closeRun = (): void => {
    const members = run;
    run = [];
    const steps = members.filter(isTurnStep);
    const first = steps[0];
    if (!first || steps.length < MIN_GROUP_STEPS) return;
    const active = turn.status === "running" && steps.some(isStepInProgress);
    groupsByFirstItemId.set(first.id, {
      id: first.id,
      steps: steps.length,
      errors: countTraceErrors(steps),
      active,
      detail: active ? currentStepLabel(steps) : stepKindSummary(members),
    });
    for (const member of members) groupIdByItemId.set(member.id, first.id);
  };

  for (const item of turn.items) {
    if (isTurnStep(item)) run.push(item);
    // A run only starts at a step, so a custom message outside one stays visible.
    else if (item.type === "customMessage" && run.length > 0) run.push(item);
    // Replies, notices and structural markers stay visible and end the run before them.
    else closeRun();
  }
  closeRun();
  return groupsByFirstItemId.size === 0 ? { mode: "flat" } : { mode: "grouped", groupsByFirstItemId, groupIdByItemId };
}

function isTurnStep(item: AgentTurnView["items"][number]): item is TurnStep {
  return item.type === "reasoning" || item.type === "tool";
}

function isStepInProgress(step: TurnStep): boolean {
  return step.type === "reasoning"
    ? step.status === "streaming"
    : step.tool.state === "preparing" || step.tool.status === "running" || step.tool.status === "queued";
}

function currentStepLabel(steps: readonly TurnStep[]): string {
  const current = [...steps].reverse().find(isStepInProgress) ?? steps.at(-1);
  if (!current) return "";
  if (current.type === "reasoning") return "Thinking";
  if (current.tool.state === "preparing") return "Preparing tool call";
  const label = current.tool.label.replace(/\s+/g, " ").trim();
  const text = label ? `${current.tool.name} ${label}` : current.tool.name;
  return text.length <= MAX_STEP_LABEL_LENGTH ? text : `${text.slice(0, MAX_STEP_LABEL_LENGTH - 1).trimEnd()}…`;
}

/** "read ×3, bash ×2, reasoning" in order of first use; a folded custom message names its type. */
function stepKindSummary(members: ReadonlyArray<TurnStep | CustomMessageView>): string {
  const counts = new Map<string, number>();
  for (const step of members) {
    const kind = step.type === "customMessage"
      ? step.customType
      : step.type === "reasoning" ? "reasoning" : step.tool.state === "bound" ? step.tool.name : "tool call";
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const kinds = [...counts].map(([kind, count]) => count > 1 ? `${kind} ×${count}` : kind);
  const shown = kinds.slice(0, MAX_GROUP_DETAIL_KINDS);
  if (kinds.length > shown.length) shown.push(`+${kinds.length - shown.length} more`);
  return shown.join(", ");
}

export function formatStepGroupLabel(group: Pick<TurnStepGroup, "steps" | "errors">): string {
  const parts = [`${group.steps} steps`];
  if (group.errors > 0) parts.push(group.errors === 1 ? "1 error" : `${group.errors} errors`);
  return parts.join(" · ");
}

/**
 * Duration label shared by turn traces and tool cards. Coarse on purpose — this reading reassures
 * the reader that work is progressing, it is not a stopwatch.
 */
export function formatDurationMs(durationMs: number): string {
  const totalSeconds = Math.round(Math.max(0, durationMs) / 1000);
  if (totalSeconds < 1) return "<1s";
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return seconds > 0 ? `${hours}h ${minutes}m ${seconds}s` : minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return seconds > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${minutes}m`;
}

/** Timestamp-span form, used where no measured duration exists. `null` when the span is unknown. */
export function formatTurnDuration(startedAt: number, endedAt?: number): string | null {
  if (endedAt === undefined || endedAt < startedAt) return null;
  return formatDurationMs(endedAt - startedAt);
}

function countTraceErrors(steps: readonly TurnStep[]): number {
  return steps.filter((step) => step.type === "tool" ? step.tool.isError || step.tool.status === "error" : step.status === "error").length;
}
