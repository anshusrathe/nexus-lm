import type {
  AgentConfig, AgentDependencies, AgentEvent, AgentSession, AgentStep,
  ToolCall, ToolResult, StepStatus
} from './types';
import { ToolRegistry } from './toolRegistry';
import { SafetyLayer } from './safetyLayer';
import { createVaultNativeTools } from './agentTools';
import { parseToolCallsFromText } from './toolCallParser';

const MAX_STEPS_DEFAULT = 25;
const COMPLEX_TASK_THRESHOLD = 8;
const LOOP_DETECTION_THRESHOLD = 3;

interface ToolCallSignature {
  name: string;
  argsKey: string;
}

export class AgentOrchestrator {
  private registry: ToolRegistry;
  private safetyLayer: SafetyLayer;
  private deps: AgentDependencies;
  private config: AgentConfig;
  private currentSession: AgentSession | null = null;
  private abortFlag: boolean = false;
  private callHistory: ToolCallSignature[] = [];

  constructor(
    registry: ToolRegistry,
    safetyLayer: SafetyLayer,
    deps: AgentDependencies,
    config: AgentConfig
  ) {
    this.registry = registry;
    this.safetyLayer = safetyLayer;
    this.deps = deps;
    this.config = config;
  }

  updateConfig(config: AgentConfig): void {
    this.config = config;
    this.safetyLayer.updateConfig(config.denyList, config.approvalMode);
  }

  abort(): void {
    this.abortFlag = true;
  }

  getSession(): AgentSession | null {
    return this.currentSession;
  }

  async runAgent(task: string, providerCall: (messages: Array<Record<string, unknown>>, onToken?: (chunk: string) => void) => Promise<{
    content?: string;
    toolCalls?: ToolCall[];
  }>, onToken?: (chunk: string) => void): Promise<string> {
    console.log('[Orchestrator] runAgent task="' + task.substring(0, 60) + '..."');
    this.abortFlag = false;
    this.callHistory = [];

    const sessionId = `agent_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    this.currentSession = {
      id: sessionId,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      task,
      steps: [],
      finalAnswer: null,
      config: this.config,
    };

    const toolDefs = this.registry.getDefinitions();
    const systemPrompt = this.buildSystemPrompt(toolDefs);
    console.log('[Orchestrator] toolDefs count=' + toolDefs.length);

    const messages: Array<Record<string, unknown>> = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: task },
    ];

    const isComplex = this.estimateComplexity(task) >= COMPLEX_TASK_THRESHOLD;
    console.log('[Orchestrator] complexity=' + this.estimateComplexity(task) + ' isComplex=' + isComplex + ' defaultMode=' + this.config.defaultMode);

    if (isComplex && this.config.defaultMode !== 'react') {
      console.log('[Orchestrator] running planning phase');
      const planResult = await this.runPlanningPhase(task, messages, (msgs, tok) => providerCall(msgs, tok), onToken);
      if (planResult !== null) {
        console.log('[Orchestrator] plan phase returned result, skipping ReAct');
        return planResult;
      }
    }

    console.log('[Orchestrator] starting ReAct loop');
    return this.runReActLoop(messages, providerCall, onToken);
  }

  private buildSystemPrompt(toolDefs: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>): string {
    const toolDescriptions = toolDefs
      .map((t) => {
        const schema = t.inputSchema ?? {};
        const props = schema && typeof schema === 'object' && 'properties' in schema
          ? (schema as Record<string, unknown>).properties as Record<string, unknown>
          : null;
        const paramNames = props
          ? Object.keys(props).join(', ')
          : Object.keys(schema).join(', ');
        return `- ${t.name}(${paramNames}): ${t.description}`;
      })
      .join('\n');

    return `You are an autonomous AI agent operating inside an Obsidian vault.

You have the following tools available:
${toolDescriptions}

Rules:
1. Think step by step. Always include "THOUGHT:" before each tool call.
2. Call one tool at a time. Wait for the result before deciding the next step.
3. When you have enough information to answer the user's request, provide a final answer enclosed in <final_answer></final_answer> tags.
4. If you encounter an error, try an alternative approach or explain what went wrong.
5. Never modify files in .obsidian/ or other hidden configuration directories.
6. For write operations, the safety system will prompt the user for approval.
7. Use edit_note for precise edits: match EXACT oldString, provide exact replacement. Never reconstruct the full file.
8. Use read_file with offset/limit or anchor to read specific sections instead of the whole file.
9. For multiple edits to the same file, use multi_edit with one edits array per file.

Editing guidelines:
- Find the exact text to replace using read_file with anchor or line numbers.
- Pass the exact text as oldString — whitespace, indentation, and line breaks must match.
- For appending, use edit_note with insertAt="end" (not by reconstructing the file).
- For prepending, use edit_note with insertAt="start".
- Never include the full file content in any parameter.
- If an edit fails, read the file again to see current content and retry with corrected oldString.

CLI tool usage:
Use cli(command="<command>") to execute any Obsidian CLI command. Do NOT include "obsidian" prefix.
Parameters use key=value syntax. Quote values with spaces: content="# Title". Use \n for newlines.
Flags are bare words: overwrite, open, total, done, todo, case, verbose.
Target vault: vault=Name before command. Target file: file=Name or path=Folder/file.md.

Available CLI commands by category:
General: help, version, reload, restart
Files: read, create, append, prepend, move, rename, delete, file, files, folder, folders, open
Search: search query=<text> [path=<folder>] [limit=<n>] [total], search:context, search:open
Daily: daily, daily:path, daily:read, daily:append content=<text>, daily:prepend content=<text>
Tags: tags [counts] [sort=count] [active], tag name=<tag>
Tasks: tasks [done] [todo] [daily] [verbose] [file=<name>] [total], task ref=<path:line> [toggle|done|todo]
Properties: aliases, properties [counts] [sort=count] [active], property:set/remove/read name=<name> [value=<value>] [file=<path>]
Plugins: plugins [filter=core|community], plugins:enabled, plugin id=<id>, plugin:enable/disable/reload id=<id>, plugin:install id=<id> [enable], plugin:uninstall id=<id>, plugins:restrict [on|off]
Links: backlinks [file=<name>] [total], links [file=<name>] [total], unresolved [total], orphans, deadends
Workspace: workspace, workspaces, workspace:save/load/delete name=<name>, tabs, tab:open [file=<path>], recents
Templates: templates, template:read name=<name> [resolve], template:insert name=<name>
Themes: themes, theme [name=<name>], theme:set name=<name>, theme:install name=<name> [enable], theme:uninstall name=<name>
Snippets: snippets, snippets:enabled, snippet:enable/disable name=<name>
Bookmarks: bookmarks [total] [verbose], bookmark [file=<path>] [folder=<path>] [search=<query>] [title=<title>]
Vault: vault, vaults, vault:open name=<name> (TUI only)
Bases: bases, base:views, base:create [file=<name>] [view=<name>] [name=<name>] [content=<text>], base:query [file=<name>] [view=<name>] [format=json|csv|tsv]
Random: random [folder=<path>], random:read [folder=<path>]
Unique: unique [name=<text>] [content=<text>] [open]
Wordcount: wordcount [file=<name>] [words] [characters]
Web: web url=<url> [newtab]
History: diff [file=<name>] [from=<n>] [to=<n>] [filter=local|sync], history:list, history:read [file=<name>] [version=<n>], history:restore [file=<name>] [version=<n>], history:open [file=<name>]
Sync: sync [on|off], sync:status, sync:history [file=<name>], sync:read [file=<name>] version=<n>, sync:restore [file=<name>] version=<n>, sync:open [file=<name>], sync:deleted
Publish: publish:site, publish:list, publish:status, publish:add [file=<name>|changed], publish:remove [file=<name>], publish:open [file=<name>]
Developer: devtools, dev:debug [on|off], dev:errors, dev:screenshot [path=<name>], dev:console [limit=<n>] [level=log|warn|error], dev:css selector=<css> [prop=<name>], dev:dom selector=<css> [text|inner|attr=<name>|css=<name>] [all], dev:mobile [on|off], eval code=<javascript>
Output format:
THOUGHT: your reasoning here
ACTION: tool_name(parameter1="value1", parameter2="value2")

Final answer format:
<final_answer>your complete answer here</final_answer>`;
  }

  private estimateComplexity(task: string): number {
    const complexityIndicators = [
      'research', 'report', 'analyze', 'compare', 'summarize',
      'create', 'write', 'organize', 'refactor', 'migrate',
      'all', 'every', 'each', 'multiple', 'several'
    ];
    let score = 0;
    const lowerTask = task.toLowerCase();
    for (const indicator of complexityIndicators) {
      if (lowerTask.includes(indicator)) {
        score += 2;
      }
    }
    const wordCount = task.split(/\s+/).length;
    if (wordCount > 20) score += 2;
    if (wordCount > 50) score += 3;
    return score;
  }

  private parseToolCall(response: string): ToolCall | null {
    const actionMatch = response.match(/ACTION:\s*(\w+)\(([\s\S]*?)\)/);
    if (!actionMatch) return null;

    const name = actionMatch[1];
    const argsString = actionMatch[2];
    const args: Record<string, unknown> = {};

    const paramRegex = /(\w+)="([^"]*)"/g;
    let paramMatch: RegExpExecArray | null;
    while ((paramMatch = paramRegex.exec(argsString)) !== null) {
      args[paramMatch[1]] = paramMatch[2];
    }

    const id = `tc_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    return { id, name, arguments: args };
  }

  private extractThought(response: string): string {
    const thoughtMatch = response.match(/THOUGHT:\s*([\s\S]*?)(?=ACTION:|<final_answer>|$)/);
    return thoughtMatch ? thoughtMatch[1].trim() : '';
  }

  private extractFinalAnswer(response: string): string | null {
    const answerMatch = response.match(/<final_answer>([\s\S]*?)<\/final_answer>/);
    return answerMatch ? answerMatch[1].trim() : null;
  }

  private detectLoop(toolName: string, args: Record<string, unknown>): boolean {
    const argsKey = JSON.stringify(args);
    this.callHistory.push({ name: toolName, argsKey });

    let count = 0;
    for (const entry of this.callHistory) {
      if (entry.name === toolName && entry.argsKey === argsKey) {
        count++;
      }
    }
    return count >= LOOP_DETECTION_THRESHOLD;
  }

  private addStep(
    thought: string,
    toolCall: ToolCall | null,
    toolResult: ToolResult | null,
    status: StepStatus
  ): void {
    if (!this.currentSession) {
      console.log('[Orchestrator] addStep SKIP - no currentSession');
      return;
    }
    const stepNumber = this.currentSession.steps.length + 1;
    console.log('[Orchestrator] addStep #' + stepNumber + ' status=' + status + ' tool=' + (toolCall?.name ?? 'none') + ' thought="' + thought.substring(0, 50) + '..."');
    const step: AgentStep = {
      stepNumber,
      thought,
      toolCall,
      toolResult,
      status,
      timestamp: Date.now(),
    };
    this.currentSession.steps.push(step);
    this.currentSession.updatedAt = Date.now();

    this.deps.onEvent({
      type: 'step',
      data: { step: step.stepNumber, status, thought, toolName: toolCall?.name ?? null },
      timestamp: Date.now(),
    });
    console.log('[Orchestrator] addStep -> onEvent fired, total steps=' + this.currentSession.steps.length);
  }

  private async checkApproval(toolCall: ToolCall): Promise<boolean> {
    if (!this.safetyLayer.needsApproval(toolCall)) return true;

    const args = toolCall.arguments;
    const path = String(args.path ?? '');
    if (path && !this.safetyLayer.isPathAllowed(path)) {
      this.addStep(
        `Path "${path}" is in the deny list. Cannot proceed.`,
        toolCall,
        { toolCallId: toolCall.id, success: false, content: '', error: `Path "${path}" is not allowed` },
        'failed'
      );
      return false;
    }

    if (path && !this.safetyLayer.isPathTraversalSafe(path)) {
      this.addStep(
        `Path "${path}" contains traversal sequences. Blocked.`,
        toolCall,
        { toolCallId: toolCall.id, success: false, content: '', error: `Path traversal detected in "${path}"` },
        'failed'
      );
      return false;
    }

    const approved = await this.safetyLayer.requestApproval(toolCall);
    if (!approved) {
      this.addStep(
        `User denied approval for ${toolCall.name}`,
        toolCall,
        { toolCallId: toolCall.id, success: false, content: '', error: 'User denied approval' },
        'failed'
      );
    }
    return approved;
  }

  private async runReActLoop(
    messages: Array<Record<string, unknown>>,
    providerCall: (messages: Array<Record<string, unknown>>, onToken?: (chunk: string) => void) => Promise<{
      content?: string;
      toolCalls?: ToolCall[];
    }>,
    onToken?: (chunk: string) => void
  ): Promise<string> {
    const maxSteps = this.config.maxSteps || MAX_STEPS_DEFAULT;
    let malformedOutputNudges = 0;
    const MAX_MALFORMED_NUDGES = 3;
    console.log('[Orchestrator] runReActLoop maxSteps=' + maxSteps + ' initial messages=' + messages.length);
    for (let step = 0; step < maxSteps; step++) {
      console.log('[Orchestrator] ReAct iteration step=' + step + '/' + maxSteps + ' abort=' + this.abortFlag + ' messages.len=' + messages.length);
      if (this.abortFlag) {
        const abortMsg = 'Agent execution aborted by user.';
        console.log('[Orchestrator] abort flag set, returning');
        this.addStep(abortMsg, null, null, 'failed');
        return abortMsg;
      }

      let response: { content?: string; toolCalls?: ToolCall[] };
      try {
        console.log('[Orchestrator] calling providerCall (iteration ' + step + ')');
        response = await providerCall(messages, onToken);
        console.log('[Orchestrator] providerCall returned content=' + (response.content ? response.content.length + ' chars' : 'undefined') + ' toolCalls=' + (response.toolCalls ? response.toolCalls.length : 'undefined'));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.log('[Orchestrator] providerCall threw:', message);
        this.addStep(`Provider call failed: ${message}`, null, null, 'failed');
        return `Agent encountered an error: ${message}`;
      }

      if (response.content) {
        const finalAnswer = this.extractFinalAnswer(response.content);
        if (finalAnswer) {
          console.log('[Orchestrator] found final_answer tag, returning');
          this.addStep('Task complete. Providing final answer.', null, null, 'completed');
          if (this.currentSession) {
            this.currentSession.finalAnswer = finalAnswer;
          }
          return finalAnswer;
        }

        if (response.toolCalls && response.toolCalls.length > 0) {
          messages.push({ role: 'assistant', content: response.content });
          console.log('[Orchestrator] processing ' + response.toolCalls.length + ' tool calls from content');
          for (const toolCall of response.toolCalls) {
            const thought = this.extractThought(response.content) || `Using ${toolCall.name}`;
            const processResult = await this.processToolCall(toolCall, thought, messages);
            if (processResult === 'abort') {
              console.log('[Orchestrator] processToolCall returned abort');
              return 'Agent execution stopped.';
            }
          }
        } else {
          malformedOutputNudges++;
          const thought = this.extractThought(response.content) || 'No specific action taken.';
          if (malformedOutputNudges >= MAX_MALFORMED_NUDGES) {
            console.log('[Orchestrator] too many malformed outputs (' + malformedOutputNudges + '), returning content as answer');
            this.addStep(thought, null, null, 'completed');
            if (this.currentSession) {
              this.currentSession.finalAnswer = thought || response.content;
            }
            return response.content;
          }
          console.log('[Orchestrator] no tool calls and no final_answer, nudging model (attempt ' + malformedOutputNudges + '/' + MAX_MALFORMED_NUDGES + ')');
          messages.push({ role: 'assistant', content: response.content });
          const nudgeMsg = 'Your output was received but no valid tool calls could be parsed. '
            + 'Please use the correct format:\n'
            + 'THOUGHT: your reasoning here\n'
            + 'ACTION: tool_name(param1="value1", param2="value2")\n\n'
            + 'If you are done with the task, wrap your answer in <final_answer></final_answer> tags.';
          messages.push({ role: 'user', content: nudgeMsg });
          this.addStep(thought + ' (malformed output, nudging model)', null, null, 'failed');
        }
      } else if (response.toolCalls && response.toolCalls.length > 0) {
        console.log('[Orchestrator] processing ' + response.toolCalls.length + ' tool calls (no content)');
        for (const toolCall of response.toolCalls) {
          const processResult = await this.processToolCall(toolCall, `Calling ${toolCall.name}`, messages);
          if (processResult === 'abort') return 'Agent execution stopped.';
        }
      } else {
        console.log('[Orchestrator] no output from model, stopping');
        this.addStep('No output from model. Stopping.', null, null, 'completed');
        return 'No output from model.';
      }
    }

    console.log('[Orchestrator] exceeded max steps (' + maxSteps + ')');
    if (this.currentSession) {
      this.currentSession.finalAnswer = this.currentSession.finalAnswer ?? 
        'Agent exceeded maximum step count. Partial results may be available.';
    }
    return 'Agent exceeded maximum step count.';
  }

  private async processToolCall(
    toolCall: ToolCall,
    thought: string,
    messages: Array<Record<string, unknown>>
  ): Promise<'continue' | 'abort'> {
    console.log('[Orchestrator] processToolCall tool=' + toolCall.name + ' args=' + JSON.stringify(toolCall.arguments));

    if (this.detectLoop(toolCall.name, toolCall.arguments)) {
      const loopMsg = `Loop detected: "${toolCall.name}" called 3+ times with same arguments. Aborting.`;
      console.log('[Orchestrator] loop detected for ' + toolCall.name);
      this.addStep(thought, toolCall, {
        toolCallId: toolCall.id, success: false, content: '', error: loopMsg
      }, 'failed');
      messages.push({ role: 'user', content: loopMsg });
      return 'continue';
    }

    const approved = await this.checkApproval(toolCall);
    if (!approved) {
      console.log('[Orchestrator] tool not approved: ' + toolCall.name);
      messages.push({
        role: 'user',
        content: `Tool ${toolCall.name} was not approved by user. Try a different approach or explain the issue.`
      });
      return 'continue';
    }

    console.log('[Orchestrator] executing tool: ' + toolCall.name);
    const result: ToolResult = await this.registry.execute(toolCall, this.deps);
    console.log('[Orchestrator] tool result success=' + result.success + ' content.len=' + result.content.length);

    this.addStep(thought, toolCall, result, result.success ? 'completed' : 'failed');
    this.deps.onEvent({
      type: 'tool_result',
      data: { toolName: toolCall.name, success: result.success },
      timestamp: Date.now(),
    });

    this.safetyLayer.logAudit({
      timestamp: Date.now(),
      toolName: toolCall.name,
      args: toolCall.arguments,
      success: result.success,
      contentPreview: result.content.substring(0, 200),
    });

    messages.push({
      role: 'user',
      content: result.success
        ? `Result from ${toolCall.name}: ${result.content.substring(0, 100000)}`
        : `Error from ${toolCall.name}: ${result.error ?? 'Unknown error'}`,
    });

    return 'continue';
  }

  private async runPlanningPhase(
    task: string,
    messages: Array<Record<string, unknown>>,
    providerCall: (messages: Array<Record<string, unknown>>, onToken?: (chunk: string) => void) => Promise<{
      content?: string;
      toolCalls?: ToolCall[];
    }>,
    onToken?: (chunk: string) => void
  ): Promise<string | null> {
    const toolDefs = this.registry.getDefinitions();
    const toolList = toolDefs.map((t) => `- ${t.name}: ${t.description}`).join('\n');

    const planPrompt = `Before executing, create a step-by-step plan for the following task:

Task: ${task}

Available tools:
${toolList}

Output a numbered plan with each step listing which tool to use and what arguments to pass.
Format:
PLAN:
1. tool_name(arg1="value1") — rationale for this step
2. tool_name(arg2="value2") — rationale
...

After the plan, wait for confirmation before executing.`;

    const planMessages: Array<Record<string, unknown>> = [
      { role: 'system', content: 'You are a planning assistant. Create concise, actionable plans.' },
      { role: 'user', content: planPrompt },
    ];

    let planResponse: { content?: string; toolCalls?: ToolCall[] };
    try {
      planResponse = await providerCall(planMessages);
    } catch {
      return null;
    }

    if (planResponse.content) {
      this.deps.onEvent({
        type: 'plan',
        data: { plan: planResponse.content, task },
        timestamp: Date.now(),
      });
    }

    return null;
  }
}
