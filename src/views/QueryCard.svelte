<script lang="ts">
  import TraceIcon from './TraceIcon.svelte';

  let { task, editable = false, onResend } = $props<{
    task: string;
    editable?: boolean;
    onResend?: (task: string) => void;
  }>();

  let editing = $state(false);
  let draft = $state('');

  function beginEdit(): void {
    draft = task;
    editing = true;
  }

  function resend(): void {
    const next = draft.trim();
    if (!next || next === task) {
      editing = false;
      return;
    }
    onResend?.(next);
  }
</script>

<section class="agent-query-card">
  <span class="agent-query-card-icon"><TraceIcon name="message-circle" /></span>
  {#if editing}
    <div class="agent-query-editor">
      <textarea bind:value={draft} rows="3" aria-label="Edit task"></textarea>
      <div class="agent-query-editor-actions">
        <button type="button" onclick={() => { editing = false; }}>Cancel</button>
        <button type="button" class="mod-cta" onclick={resend}>Save and resend</button>
      </div>
    </div>
  {:else}
    <span class="agent-query-card-text">{task}</span>
    <div class="agent-query-actions">
      <button type="button" class="agent-query-action-btn" aria-label="Copy task" onclick={() => void navigator.clipboard.writeText(task)}><TraceIcon name="copy" /></button>
      {#if editable}
        <button type="button" class="agent-query-action-btn" aria-label="Edit and resend task" onclick={beginEdit}><TraceIcon name="pencil" /></button>
      {/if}
    </div>
  {/if}
</section>
