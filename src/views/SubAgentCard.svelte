<script lang="ts">
  import type { App } from 'obsidian';
  import type { TraceSubAgent } from './agentTraceTypes';
  import ActionBox from './ActionBox.svelte';
  import MarkdownContent from './MarkdownContent.svelte';
  import TraceIcon from './TraceIcon.svelte';

  let { app, session } = $props<{ app: App; session: TraceSubAgent }>();
  let open = $state(true);

  let hasContent = $derived(session.steps.length > 0 || session.result || session.status === 'running');
</script>

<section class="agent-subagent-container">
  <button type="button" class="agent-subagent-header" aria-expanded={open} onclick={() => { open = !open; }}>
    <span class="agent-subagent-icon" class:agent-action-spin={session.status === 'running'}><TraceIcon name={session.status === 'running' ? 'loader-circle' : 'bot'} /></span>
    <span class="agent-subagent-title">{session.agentType}</span>
    <span class="agent-subagent-task">{session.task}</span>
    <span class={`agent-subagent-status agent-subagent-status--${session.status}`}>{session.status}</span>
    <TraceIcon name={open ? 'chevron-up' : 'chevron-down'} />
  </button>
  {#if open && hasContent}
    <div class="agent-subagent-body">
      {#each session.steps as step (step.stepNumber)}
        {#if step.thought}
          <div class="agent-subagent-thoughts">{step.thought}</div>
        {/if}
        {#if step.toolName}
          <ActionBox {step} />
        {/if}
      {/each}

      {#if session.result}
        <div class="agent-subagent-answer">
          <MarkdownContent {app} content={session.result.summary} className="agent-subagent-answer-content" />
          {#if session.result.error}
            <div class="agent-subagent-result-error">{session.result.error}</div>
          {/if}
          <div class="agent-subagent-result-footer">
            <TraceIcon name={session.result.success ? 'circle-check' : 'circle-x'} />
            <span>{session.result.stepsTaken} steps</span>
          </div>
        </div>
      {:else if session.status === 'running'}
        <div class="agent-inline-spinner"><TraceIcon name="loader-circle" /><span>Working independently</span></div>
      {/if}
    </div>
  {/if}
</section>
