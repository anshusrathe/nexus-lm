<script lang="ts">
  import type { AgentContextItem } from './agentTraceTypes';
  import TraceIcon from './TraceIcon.svelte';

  let { items = [] as AgentContextItem[] } = $props<{ items?: AgentContextItem[] }>();

  function iconFor(item: AgentContextItem): string {
    if (item.type === 'embedding-index') return 'database';
    switch ((item.extension || '').toLowerCase()) {
      case 'md': return 'file-text';
      case 'canvas': return 'layout-dashboard';
      case 'pdf': return 'file';
      case 'png':
      case 'jpg':
      case 'jpeg':
      case 'gif':
      case 'svg': return 'image';
      default: return 'file';
    }
  }
</script>

{#if items.length}
  <details class="agent-context-card">
    <summary class="agent-context-card-header">
      <span class="agent-context-card-header-icon"><TraceIcon name="paperclip" /></span>
      <span class="agent-context-card-title">Attached context</span>
      <span class="agent-context-card-count">{items.length}</span>
      <span class="agent-context-card-chevron"><TraceIcon name="chevron-right" /></span>
    </summary>
    <div class="agent-context-card-list">
      {#each items as item}
        <div class="agent-context-card-item" title={item.path || item.name}>
          <span class="agent-context-card-item-icon"><TraceIcon name={iconFor(item)} /></span>
          <span class="agent-context-card-item-name">{item.name}</span>
          <span class="agent-context-card-item-kind">{item.type === 'embedding-index' ? 'Database' : (item.extension || 'File').toUpperCase()}</span>
        </div>
      {/each}
    </div>
  </details>
{/if}
