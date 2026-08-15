<script lang="ts">
  import type { App } from 'obsidian';
  import type { AgentEvent } from '../agent/types';
  import { adaptTrace, type AgentContextItem, type AgentTraceTurn } from './agentTraceTypes';
  import ActionBox from './ActionBox.svelte';
  import ContextCard from './ContextCard.svelte';
  import MarkdownContent from './MarkdownContent.svelte';
  import QueryCard from './QueryCard.svelte';
  import SubAgentCard from './SubAgentCard.svelte';
  import TraceIcon from './TraceIcon.svelte';

  let { app, turn = null as AgentTraceTurn | null, task = '', events = [] as AgentEvent[], contextItems = [] as AgentContextItem[], running = false, modelName = '', elapsed = '', startTime = 0, turnIndex = 0, onResend, onApprove, onRevert } = $props<{
    app: App;
    turn?: AgentTraceTurn | null;
    task?: string;
    events?: AgentEvent[];
    contextItems?: AgentContextItem[];
    running?: boolean;
    modelName?: string;
    elapsed?: string;
    startTime?: number;
    turnIndex?: number;
    onResend?: (task: string) => void;
    onApprove?: (approvalId: string) => void;
    onRevert?: (approvalId: string) => void;
  }>();

  let activeTask = $derived(turn?.task ?? task);
  let activeEvents = $derived(turn?.events ?? events);
  let trace = $derived(adaptTrace(activeEvents));
  let subAgentById = $derived(new Map(trace.subAgents.map(s => [s.jobId, s])));
  let answer = $derived(turn?.answer ?? trace.finalAnswer);
  let activeContextItems = $derived(turn?.contextItems ?? contextItems);

  let copied = $state(false);
  let tokenEstimate = $derived(Math.max(1, Math.ceil((answer || trace.streamingText || '').length / 4)));

  const FILLER_PHRASES = [
    'agent is starting',
    'analyzing your request',
    'retrieving relevant context',
    'formulating strategy',
    'gathering intelligence',
    'initializing agent tools',
    'evaluating options',
  ];

  const HEADER_VERBS = [
    'Worked for',
    'Cooked for',
    'Hustled for',
    'Thought for',
    'Processed in',
    'Executed in',
    'Completed in',
    'Soliloquized for',
    'Reasoned for',
  ];

  function getRandomPhrase(): string {
    const idx = Math.floor(Math.random() * FILLER_PHRASES.length);
    return FILLER_PHRASES[idx];
  }

  function getRandomHeaderVerb(): string {
    const idx = Math.floor(Math.random() * HEADER_VERBS.length);
    return HEADER_VERBS[idx];
  }

  function isFillerThought(text: string): boolean {
    const trimmed = (text || '').trim();
    if (!trimmed || trimmed.length < 4) return true;
    return /^(using|calling|running|executing|starting)\s+[\w\s._/-]+\s*$/i.test(trimmed);
  }

  function formatTime(elapsedStr?: string): string {
    if (!elapsedStr) return '';
    const parts = elapsedStr.split(':');
    if (parts.length === 2) {
      const min = parseInt(parts[0], 10);
      const sec = parseInt(parts[1], 10);
      return min > 0 ? `${min}m${sec.toString().padStart(2, '0')}s` : `${sec}s`;
    }
    return elapsedStr;
  }

  function formatMs(ms: number): string {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return min > 0 ? `${min}m${sec.toString().padStart(2, '0')}s` : `${sec}s`;
  }

  let randomPhrase = $state(getRandomPhrase());
  let headerVerb = $state(getRandomHeaderVerb());
  let nowMs = $state(0);
  let isExecutionOpen = $state(true);

  $effect(() => {
    if (running && startTime > 0) {
      nowMs = Date.now();
      const id = window.setInterval(() => {
        nowMs = Date.now();
      }, 1000);
      return () => window.clearInterval(id);
    }
  });

  let liveElapsed = $derived(
    running && startTime > 0 ? Math.max(0, nowMs - startTime) : 0
  );

  let displayHeaderText = $derived(
    running
      ? `Working for ${formatMs(liveElapsed)}`
      : `${headerVerb} ${formatTime(elapsed)}...`
  );

  function toggleExecution(): void {
    if (running) return;
    isExecutionOpen = !isExecutionOpen;
  }

  $effect(() => {
    if (running && !trace.modelStatus) {
      randomPhrase = getRandomPhrase();
      const interval = window.setInterval(() => {
        randomPhrase = getRandomPhrase();
      }, 3500);
      return () => window.clearInterval(interval);
    }
  });

  let currentPhrase = $derived(
    trace.modelStatus ? trace.modelStatus.status : randomPhrase
  );

  async function copy(): Promise<void> {
    const text = answer || trace.streamingText;
    if (!text) return;
    await navigator.clipboard.writeText(text);
    copied = true;
    window.setTimeout(() => { copied = false; }, 1200);
  }

  let hasExecution = $derived(
    trace.timeline.length > 0
  );

  let hasAnswer = $derived(
    Boolean(trace.streamingText || answer)
  );

  $effect(() => {
    if (!running && hasAnswer) isExecutionOpen = false;
  });

  let hasContent = $derived(
    hasExecution || hasAnswer || Boolean(trace.error)
  );
</script>

<article class="agent-turn-card" class:agent-turn-card--active={running} data-agent-turn-index={turnIndex}>
  <QueryCard task={activeTask} editable={Boolean(turn)} {onResend} />
  <ContextCard items={activeContextItems} />

  {#if running && (!hasContent || (trace.modelStatus && !trace.modelStatus.isMidway))}
    <div class="agent-pinwheel-loader" class:agent-pinwheel-failure={Boolean(trace.modelStatus)}>
      <div class="agent-pinwheel-icon">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 12A10 10 0 0 0 12 2v10z"/>
          <path d="M12 22A10 10 0 0 0 22 12H12z"/>
          <path d="M2 12a10 10 0 0 0 10 10V12z"/>
          <path d="M12 2a10 10 0 0 0-10 10h10z"/>
        </svg>
      </div>
      <span class="agent-pinwheel-text">
        {currentPhrase}
        <span class="typing-dots">
          <span class="dot"></span>
          <span class="dot"></span>
          <span class="dot"></span>
        </span>
      </span>
    </div>
  {/if}

  {#if hasContent}
    <div class="agent-response-card">
      {#if trace.error}<div class="agent-trace-error"><TraceIcon name="triangle-alert" /><span>{trace.error}</span></div>{/if}

      {#if hasExecution}
        <div class="agent-execution-toggle">
          <div
            class="agent-execution-summary"
            role="button"
            tabindex="0"
            aria-expanded={isExecutionOpen}
            title={running ? undefined : isExecutionOpen ? 'Collapse execution' : 'Expand execution'}
            onclick={toggleExecution}
            onkeydown={(e) => {
              if (!running && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault();
                toggleExecution();
              }
            }}
          >
            {#if running}
              <span class="agent-execution-chevron"><TraceIcon name="activity" /></span>
            {:else}
              <span class="agent-execution-chevron" class:is-open={isExecutionOpen}><TraceIcon name="chevron-right" /></span>
            {/if}
            <span class="agent-execution-title">{displayHeaderText}</span>
          </div>
          {#if isExecutionOpen}
            <div class="agent-execution-content">
              {#each trace.timeline as item (item.id)}
                {#if item.kind === 'thought' && item.thought}
                  <div class="agent-response-thoughts">{item.thought}</div>
                {:else if item.kind === 'step'}
                  {#if item.step?.thought && !isFillerThought(item.step.thought)}
                    <div class="agent-response-thoughts">{item.step.thought}</div>
                  {/if}
                  {#if item.step?.toolName}
                    <ActionBox step={item.step} {onApprove} {onRevert} />
                  {/if}
                {:else if item.kind === 'pending_action'}
                  <ActionBox step={item.action} pending />
                {:else if item.kind === 'subagent'}
                  {@const subSession = subAgentById.get(item.jobId ?? '')}
                  {#if subSession}
                    <SubAgentCard {app} session={subSession} />
                  {/if}
                {/if}
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      {#if running && trace.streamingText}
        <MarkdownContent {app} content={trace.streamingText} streaming className="agent-response-streaming" />
      {/if}

      {#if running && trace.modelStatus && trace.modelStatus.isMidway}
        <div class="agent-pinwheel-loader agent-pinwheel-midway agent-pinwheel-failure">
          <div class="agent-pinwheel-icon">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 12A10 10 0 0 0 12 2v10z"/>
              <path d="M12 22A10 10 0 0 0 22 12H12z"/>
              <path d="M2 12a10 10 0 0 0 10 10V12z"/>
              <path d="M12 2a10 10 0 0 0-10 10h10z"/>
            </svg>
          </div>
          <span class="agent-pinwheel-text">
            {trace.modelStatus.status}
            <span class="typing-dots">
              <span class="dot"></span>
              <span class="dot"></span>
              <span class="dot"></span>
            </span>
          </span>
        </div>
      {/if}

      {#if !running && answer}
        <MarkdownContent {app} content={answer} className="agent-response-final" />
        <footer class="agent-response-footer">
          <span class="agent-response-model-name"><TraceIcon name="sparkles" /><span>{modelName || 'Agent'} - ~{tokenEstimate.toLocaleString()} tokens</span></span>
          <button type="button" class="agent-response-action-btn" aria-label="Copy response" onclick={() => void copy()}><TraceIcon name={copied ? 'check' : 'copy'} /></button>
        </footer>
      {/if}
    </div>
  {/if}
</article>
