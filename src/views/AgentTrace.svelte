<script lang="ts">
  import type { App } from 'obsidian';
  import type { AgentEvent } from '../agent/types';
  import AgentTurn from './AgentTurn.svelte';
  import TraceIcon from './TraceIcon.svelte';
  import type { AgentContextItem, AgentTraceTurn } from './agentTraceTypes';

  let { app, onApprove, onRevert } = $props<{
    completedTurns: AgentTraceTurn[];
    currentTask: string;
    currentEvents: AgentEvent[];
    isRunning: boolean;
    app: App;
    modelNames?: string[];
    turnElapsedTimes?: string[];
    currentStartTime?: number;
    onRevertTurn?: (turnIndex: number, newTask: string) => void | Promise<void>;
    currentContextItems?: AgentContextItem[];
    onApprove?: (approvalId: string) => void;
    onRevert?: (approvalId: string) => void;
  }>();

  let completedTurns = $state<AgentTraceTurn[]>([]);
  let currentTask = $state('');
  let currentEvents = $state<AgentEvent[]>([]);
  let isRunning = $state(false);
  let modelNames = $state<string[]>([]);
  let turnElapsedTimes = $state<string[]>([]);
  let currentStartTime = $state(0);
  let onRevertTurn = $state<((turnIndex: number, newTask: string) => void | Promise<void>) | undefined>(undefined);
  let currentContextItems = $state<AgentContextItem[]>([]);

  export function updateTrace(next: {
    completedTurns: AgentTraceTurn[];
    currentTask: string;
    currentEvents: AgentEvent[];
    isRunning: boolean;
    modelNames: string[];
    turnElapsedTimes: string[];
    currentStartTime?: number;
    onRevertTurn?: (turnIndex: number, newTask: string) => void | Promise<void>;
    currentContextItems?: AgentContextItem[];
  }): void {
    completedTurns = next.completedTurns;
    currentTask = next.currentTask;
    currentEvents = next.currentEvents;
    isRunning = next.isRunning;
    modelNames = next.modelNames;
    turnElapsedTimes = next.turnElapsedTimes;
    currentStartTime = next.currentStartTime || 0;
    onRevertTurn = next.onRevertTurn;
    currentContextItems = next.currentContextItems || [];
  }
</script>

<div class="agent-trace-container">
  {#if !completedTurns.length && !currentTask && !isRunning}
    <section class="agent-trace-empty">
      <div class="agent-trace-empty-mark"><TraceIcon name="orbit" /></div>
      <h3>Ready to work</h3>
      <p>Describe an outcome. The agent will reason, use tools, and keep the full execution trace here.</p>
    </section>
  {/if}

  {#each completedTurns as turn, index (turn.task + '-' + index)}
    <AgentTurn {app} {turn} turnIndex={index} modelName={modelNames[index] || ''} elapsed={turnElapsedTimes[index] || ''} onResend={(task) => { onRevertTurn?.(index, task); }} {onApprove} {onRevert} />
    {#if index < completedTurns.length - 1 || currentTask}<div class="agent-turn-separator"></div>{/if}
  {/each}

  {#if currentTask || isRunning}
    <AgentTurn {app} task={currentTask} events={currentEvents} contextItems={currentContextItems} running={isRunning} startTime={currentStartTime} turnIndex={completedTurns.length} {onApprove} {onRevert} />
  {/if}
</div>
