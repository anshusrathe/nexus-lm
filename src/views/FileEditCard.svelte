<script lang="ts">
  import type { FileEditDiff } from '../agent/types';
  import TraceIcon from './TraceIcon.svelte';

  let { edit, approvalState = null, approvalId = null, onApprove, onRevert } = $props<{
    edit: FileEditDiff;
    approvalState?: 'pending' | 'approved' | 'reverted' | null;
    approvalId?: string | null;
    onApprove?: (id: string) => void;
    onRevert?: (id: string) => void;
  }>();
  let open = $state(false);

  let isPending = $derived(approvalState === 'pending');
  let isApproved = $derived(approvalState === 'approved');
  let isReverted = $derived(approvalState === 'reverted');
  let showButton = $derived(isPending || isApproved || isReverted);

  function handleApprove(e: Event): void {
    e.preventDefault();
    e.stopPropagation();
    if (approvalId) onApprove?.(approvalId);
  }

  function handleRevert(e: Event): void {
    e.preventDefault();
    e.stopPropagation();
    if (approvalId) onRevert?.(approvalId);
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      if (isPending && approvalId) onApprove?.(approvalId);
      else if ((isApproved || isReverted) && approvalId) onRevert?.(approvalId);
    }
  }
</script>

<div class="agent-file-edit">
  <div class="agent-action-box-row">
    <button type="button" class="agent-action-box" aria-expanded={open} onclick={() => { open = !open; }}>
      <span class="agent-action-box-icon"><TraceIcon name={open ? 'chevron-down' : 'chevron-right'} /></span>
      <span class="agent-action-box-label">Changed</span>
      <span class="agent-action-box-name">{edit.cliCommand || edit.path}</span>
      {#if !edit.cliCommand}
        <span class="agent-step-diff-stats"><span class="agent-step-diff-removals">-{edit.removals}</span><span class="agent-step-diff-additions">+{edit.additions}</span></span>
      {/if}
    </button>
    {#if showButton && approvalId}
      <span
        role="button"
        tabindex="0"
        class="agent-approval-btn"
        class:agent-approval-btn--pending={isPending}
        class:agent-approval-btn--approved={isApproved}
        class:agent-approval-btn--reverted={isReverted}
        onclick={isPending ? handleApprove : handleRevert}
        onkeydown={handleKeydown}
        title={isPending ? 'Approve file operation' : isReverted ? 'Re-apply file operation' : 'Revert file operation'}
      >
        {#if isPending}
          <TraceIcon name="check" />
        {:else if isReverted}
          <TraceIcon name="check" />
        {:else}
          <TraceIcon name="undo-2" />
        {/if}
      </span>
    {/if}
  </div>
  {#if open}
    <div class="agent-action-box-detail">
      {#if edit.cliCommand}
        <div class="agent-step-cli-command"><TraceIcon name="terminal" /><code class="agent-step-cli-code">{edit.cliCommand}</code></div>
      {:else}
        <div class="agent-step-diff-path">{edit.path}</div>
        <div class="agent-step-diff-body">
          {#each edit.diffLines as line}
            <div class={`agent-step-diff-line agent-step-diff-line--${line.type}`}>
              <span class="agent-step-diff-marker">{line.type === 'added' ? '+' : '-'}</span>
              <span class="agent-step-diff-text">{line.content}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>
