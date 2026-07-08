<script lang="ts">
  import { setIcon, MarkdownRenderer, Component, type App } from 'obsidian';
  import { onMount, onDestroy, tick } from 'svelte';

  interface StepData {
    stepNumber: number;
    thought: string;
    toolName: string | null;
    toolResult: string | null;
    status: string;
    timestamp: number;
  }

  interface TraceEvent {
    type: 'step' | 'thought' | 'tool_call' | 'tool_result' | 'error' | 'final_answer' | 'plan' | 'answer_chunk';
    data: Record<string, unknown>;
    timestamp: number;
  }

  interface TurnData {
    task: string;
    events: TraceEvent[];
    answer: string | null;
  }

  let { completedTurns = [] as TurnData[], currentTask = '', currentEvents = [] as TraceEvent[], isRunning = false, app = null as unknown as App } = $props<{
    completedTurns: TurnData[];
    currentTask: string;
    currentEvents: TraceEvent[];
    isRunning: boolean;
    app: App;
  }>();

  function computeSteps(events: TraceEvent[]): StepData[] {
    return events
      .filter((e: TraceEvent) => e.type === 'step')
      .map((e: TraceEvent) => ({
        stepNumber: Number(e.data.step ?? 0),
        thought: String(e.data.thought ?? ''),
        toolName: e.data.toolName ? String(e.data.toolName) : null,
        toolResult: null,
        status: String(e.data.status ?? 'pending'),
        timestamp: e.timestamp,
      }));
  }

  function computePlan(events: TraceEvent[]): string | null {
    const planEvent = events.find((e: TraceEvent) => e.type === 'plan');
    if (!planEvent) return null;
    return String(planEvent.data.plan ?? '');
  }

  function computeFinalAnswer(events: TraceEvent[]): string | null {
    const answerEvent = events.find((e: TraceEvent) => e.type === 'final_answer');
    if (!answerEvent) return null;
    return String(answerEvent.data.answer ?? '');
  }

  function computeStreamingText(events: TraceEvent[]): string | null {
    const chunkEvents = events.filter((e: TraceEvent) => e.type === 'answer_chunk');
    if (chunkEvents.length === 0) return null;
    return String(chunkEvents[chunkEvents.length - 1].data.text ?? '');
  }

  let currentStepsListEl: HTMLDivElement | undefined = $state();
  let containerEl: HTMLDivElement | undefined = $state();
  let stepsCollapsed = $state(false);
  let userToggledSteps = $state(false);
  let collapsedTurns = $state<Set<number>>(new Set());
  let prevCompletedCount = 0;

  function toggleCompletedTurn(index: number): void {
    const newSet = new Set(collapsedTurns);
    if (newSet.has(index)) {
      newSet.delete(index);
    } else {
      newSet.add(index);
    }
    collapsedTurns = newSet;
  }

  $effect(() => {
    const fa = computeFinalAnswer(currentEvents);
    if (fa && !isRunning && !userToggledSteps) {
      stepsCollapsed = true;
    }
    if (!currentTask && !isRunning) {
      userToggledSteps = false;
    }
  });

  $effect(() => {
    const turns = completedTurns;
    if (turns.length > prevCompletedCount) {
      const newSet = new Set(collapsedTurns);
      for (let i = prevCompletedCount; i < turns.length; i++) {
        if (turns[i].answer) {
          newSet.add(i);
        }
      }
      prevCompletedCount = turns.length;
      collapsedTurns = newSet;
    }
  });

  function toggleSteps(): void {
    stepsCollapsed = !stepsCollapsed;
    userToggledSteps = true;
  }

  function getStatusIcon(status: string): string {
    switch (status) {
      case 'running': return 'loader-pinwheel';
      case 'completed': return 'check-circle';
      case 'failed': return 'x-circle';
      case 'skipped': return 'skip-forward';
      default: return 'circle';
    }
  }

  function getStatusClass(status: string): string {
    return `agent-step-status agent-step-status--${status}`;
  }

  function formatTime(ts: number): string {
    const date = new Date(ts);
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function applyIcons(el: HTMLDivElement | undefined): void {
    if (!el) return;
    const iconElements = el.querySelectorAll('[data-lucide-icon]');
    iconElements.forEach((el) => {
      const iconName = el.getAttribute('data-lucide-icon') ?? '';
      setIcon(el as HTMLElement, iconName);
    });
  }

  let mdComponent: Component;

  onMount(() => {
    applyIcons(containerEl);
    mdComponent = new Component();
    mdComponent.load();
  });

  onDestroy(() => {
    if (mdComponent) {
      mdComponent.unload();
    }
  });

  let prevAnswerSnapshot = '';
  let lastStreamRender = 0;
  const STREAM_THROTTLE = 200;

  $effect(() => {
    const turns = completedTurns;
    const events = currentEvents;
    const running = isRunning;

    tick().then(() => {
      if (!containerEl || !mdComponent || !app) return;

      const snapshot = turns.map(t => t.answer ?? '').join('\x00') + '\x00' + (computeFinalAnswer(events) ?? '');
      if (snapshot !== prevAnswerSnapshot) {
        prevAnswerSnapshot = snapshot;
        const answerEls = containerEl.querySelectorAll('.agent-final-answer-content');
        let elIdx = 0;

        for (const turn of turns) {
          if (turn.answer && answerEls[elIdx]) {
            answerEls[elIdx].empty();
            MarkdownRenderer.render(app, turn.answer, answerEls[elIdx] as HTMLElement, '', mdComponent);
            elIdx++;
          }
        }

        const finalAnswer = computeFinalAnswer(events);
        if (finalAnswer && !running && answerEls[elIdx]) {
          answerEls[elIdx].empty();
          MarkdownRenderer.render(app, finalAnswer, answerEls[elIdx] as HTMLElement, '', mdComponent);
        }
      }

      const streamingText = computeStreamingText(events);
      const streamingEl = containerEl.querySelector('.agent-streaming-content');
      if (streamingText && streamingEl && running) {
        const now = Date.now();
        if (now - lastStreamRender > STREAM_THROTTLE) {
          lastStreamRender = now;
          streamingEl.empty();
          MarkdownRenderer.render(app, streamingText, streamingEl as HTMLElement, '', mdComponent);
        } else {
          streamingEl.textContent = streamingText;
        }
      }
    });
  });

  $effect(() => {
    if (containerEl) {
      window.setTimeout(() => applyIcons(containerEl), 0);
    }
    if (currentStepsListEl) {
      window.setTimeout(() => {
        currentStepsListEl.scrollTop = currentStepsListEl.scrollHeight;
      }, 50);
    }
  });
</script>

<div bind:this={containerEl} class="agent-trace-container">
  {#if completedTurns.length === 0 && !currentTask && !isRunning}
    <div class="agent-trace-empty">
      <div class="agent-trace-empty-icon" data-lucide-icon="bot"></div>
      <p class="agent-trace-empty-text">Agent ready. Enter a task to begin.</p>
    </div>
  {:else}
    {#each completedTurns as turn, i}
      <div class="agent-turn-card">
        <div class="agent-query-card">
          <span class="agent-query-card-icon" data-lucide-icon="message-circle"></span>
          <span class="agent-query-card-text">{turn.task}</span>
        </div>

        {#if computePlan(turn.events)}
          <div class="agent-plan-section">
            <div class="agent-plan-header">
              <span class="agent-plan-header-icon" data-lucide-icon="list"></span>
              <span class="agent-plan-header-text">Plan</span>
            </div>
            <div class="agent-plan-content">
              {#each computePlan(turn.events)!.split('\n') as line}
                {#if line.trim()}
                  <div class="agent-plan-line">{line}</div>
                {/if}
              {/each}
            </div>
          </div>
        {/if}

        {#if computeSteps(turn.events).length > 0}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="agent-steps-header" role="button" tabindex="0" onmousedown={() => toggleCompletedTurn(i)}>
            <span class="agent-steps-header-icon" data-lucide-icon={collapsedTurns.has(i) ? 'chevron-right' : 'chevron-down'}></span>
            <span class="agent-steps-header-label">Execution Steps</span>
            <span class="agent-steps-header-count">{computeSteps(turn.events).length}</span>
          </div>
        {/if}
        {#if !collapsedTurns.has(i) && computeSteps(turn.events).length > 0}
          <div class="agent-steps-list">
            {#each computeSteps(turn.events) as step (step.stepNumber)}
              <div class="agent-step-row">
                <div class="agent-step-card {getStatusClass(step.status)}">
                  <div class="agent-step-header">
                    <span class="agent-step-icon" data-lucide-icon={getStatusIcon(step.status)}></span>
                    <span class="agent-step-number">Step {step.stepNumber}</span>
                    <span class="agent-step-time">{formatTime(step.timestamp)}</span>
                  </div>
                  {#if step.thought}
                    <div class="agent-step-thought">
                      <span class="agent-step-label">Thought:</span>
                      {step.thought}
                    </div>
                  {/if}
                  {#if step.toolName}
                    <div class="agent-step-tool">
                      <span class="agent-step-tool-icon" data-lucide-icon="wrench"></span>
                      <span class="agent-step-tool-name">{step.toolName}</span>
                    </div>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {/if}

        {#if turn.answer}
          <div class="agent-final-answer">
            <div class="agent-final-answer-content"></div>
          </div>
        {/if}
      </div>

      {#if i < completedTurns.length - 1 || currentTask || isRunning}
        <div class="agent-turn-separator"></div>
      {/if}
    {/each}

    {#if currentTask || isRunning}
      <div class="agent-turn-card agent-turn-card--active">
        <div class="agent-query-card">
          <span class="agent-query-card-icon" data-lucide-icon="message-circle"></span>
          <span class="agent-query-card-text">{currentTask}</span>
        </div>

        {#if computePlan(currentEvents)}
          <div class="agent-plan-section">
            <div class="agent-plan-header">
              <span class="agent-plan-header-icon" data-lucide-icon="list"></span>
              <span class="agent-plan-header-text">Plan</span>
            </div>
            <div class="agent-plan-content">
              {#each computePlan(currentEvents)!.split('\n') as line}
                {#if line.trim()}
                  <div class="agent-plan-line">{line}</div>
                {/if}
              {/each}
            </div>
          </div>
        {/if}

        {#if computeSteps(currentEvents).length > 0 || isRunning}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="agent-steps-header" role="button" tabindex="0" onmousedown={toggleSteps}>
            <span class="agent-steps-header-icon" data-lucide-icon={stepsCollapsed ? 'chevron-right' : 'chevron-down'}></span>
            <span class="agent-steps-header-label">Execution Steps</span>
            {#if computeSteps(currentEvents).length > 0}
              <span class="agent-steps-header-count">{computeSteps(currentEvents).length}</span>
            {/if}
          </div>
        {/if}
        {#if !stepsCollapsed && (computeSteps(currentEvents).length > 0 || isRunning)}
          <div bind:this={currentStepsListEl} class="agent-steps-list">
            {#each computeSteps(currentEvents) as step (step.stepNumber)}
              <div class="agent-step-row">
                <div class="agent-step-card {getStatusClass(step.status)}">
                  <div class="agent-step-header">
                    <span class="agent-step-icon" data-lucide-icon={getStatusIcon(step.status)}></span>
                    <span class="agent-step-number">Step {step.stepNumber}</span>
                    <span class="agent-step-time">{formatTime(step.timestamp)}</span>
                  </div>
                  {#if step.thought}
                    <div class="agent-step-thought">
                      <span class="agent-step-label">Thought:</span>
                      {step.thought}
                    </div>
                  {/if}
                  {#if step.toolName}
                    <div class="agent-step-tool">
                      <span class="agent-step-tool-icon" data-lucide-icon="wrench"></span>
                      <span class="agent-step-tool-name">{step.toolName}</span>
                    </div>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {/if}

        {#if computeStreamingText(currentEvents) && isRunning}
          <div class="agent-streaming-answer">
            <div class="agent-streaming-header">
              <span class="agent-streaming-label">Generating...</span>
            </div>
            <div class="agent-streaming-content"></div>
          </div>
        {/if}

        {#if computeFinalAnswer(currentEvents) && !isRunning}
          <div class="agent-final-answer">
            <div class="agent-final-answer-content"></div>
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</div>
