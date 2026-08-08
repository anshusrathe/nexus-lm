import { Platform } from 'obsidian';
import type { ToolHandler } from './toolRegistry';
import type { AgentDependencies } from './types';
import { executeCliCommand } from './cliExecutor';

const CLI_DISABLED_TOOL: ToolHandler = {
  definition: {
    name: 'cli_disabled',
    description: 'CLI tools are disabled. Enable them in the Nexus-LM plugin settings (Tools tab \u2192 Agent \u2192 Enable CLI).',
    category: 'cli',
    inputSchema: { type: 'object', properties: {}, required: [] },
    needsApproval: false,
  },
  execute: async (): Promise<string> => {
    return 'CLI tools are disabled in the plugin settings. Open Nexus-LM Settings \u2192 Tools \u2192 Agent and enable "Enable CLI tools".';
  },
};

const CLI_TOOL: ToolHandler = {
  definition: {
    name: 'cli',
    description: 'Execute any Obsidian CLI command via the terminal. Uses the real obsidian CLI binary. Examples:\n'
      + '  cli(command="search query=meeting limit=10")\n'
      + '  cli(command=\'read path="Folder/Note.md"\')\n'
      + '  cli(command="daily:append content=\\"- [ ] Buy groceries\\"")\n'
      + '  cli(command="tags total")\n'
      + '  cli(command="eval code=app.vault.getFiles().length")\n'
      + '  cli(command="files folder=Inbox ext=md total")\n'
      + '  cli(command="create name=Note content=\\"# Title\\"\\n\\nBody" open overwrite")\n'
      + 'See the system prompt or CLI docs for the full command reference.',
    category: 'cli',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Full CLI command excluding the "obsidian" prefix. Example: \'search query="meeting notes" limit=10\'.' },
      },
      required: ['command'],
    },
    needsApproval: false,
  },
  execute: async (args: Record<string, unknown>, deps: AgentDependencies): Promise<string> => {
    const command = String(args.command ?? '');
    if (!command) {
      return 'Error: command parameter is required. Example: cli(command="search query=meeting limit=10")';
    }

    const settings = deps.settings as Record<string, unknown>;
    const explicitPath = String(settings.agentCliBinaryPath ?? '') || undefined;

    const result = await executeCliCommand(command, 60000, explicitPath, (chunk) => {
      deps.onEvent({
        type: 'tool_progress',
        data: { toolName: 'cli', chunk },
        timestamp: Date.now(),
      });
    });

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `CLI command failed with exit code ${result.exitCode}`);
    }

    if (result.stdout) return result.stdout;
    if (result.stderr) return `Command completed with stderr:\n${result.stderr}`;
    return 'Command completed successfully (no output).';
  },
};

export function createCLITools(cliEnabled: boolean): ToolHandler[] {
  if (!Platform.isDesktop || !cliEnabled) {
    return [CLI_DISABLED_TOOL];
  }

  return [CLI_TOOL];
}
