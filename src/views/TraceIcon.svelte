<script lang="ts">
  import { setIcon } from 'obsidian';

  let { name, label = '' } = $props<{ name: string; label?: string }>();
  let element: HTMLSpanElement | undefined = $state();

  $effect(() => {
    name;
    if (element) setIcon(element, name);
  });
</script>

<span bind:this={element} class="agent-icon" aria-label={label || undefined} aria-hidden={label ? undefined : 'true'}></span>
