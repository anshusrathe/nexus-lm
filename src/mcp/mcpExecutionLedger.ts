/**
 * MCP Execution Ledger
 *
 * Implements a two-phase approach for robust MCP tool calling in automodel chains:
 *
 * Phase 1 — Planning: A single LLM call produces a JSON execution plan listing
 *   which tools to call, with what arguments, and in what dependency order.
 *
 * Phase 2 — Execution: Tools are executed against the plan using a stateful ledger.
 *   The ledger is the single source of truth — no summarization, no lossy text
 *   conversion. Any model in the fallback chain picks up the same ledger and
 *   synthesises from structured, per-step results.
 *
 * Key properties:
 *  - Independent steps execute in parallel (Promise.all)
 *  - Dependent steps wait for their prerequisites
 *  - Per-step retry with configurable maxRetries
 *  - Failed step dependents are automatically skipped
 *  - Model fallback for failures (tries next model in chain)
 *  - Provider cooldown for rate limits (429)
 *  - Tool chunking for large tool sets
 *  - Timeout support to prevent hanging
 *  - Synthesis attempts are capped (MAX_SYNTHESIS_ATTEMPTS) to prevent chain thrashing
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
export type Provider = 'groq' | 'gemini' | 'openrouter' | 'ollama' | 'nvidia';

export interface MCPPlanStep {
    stepId: string;
    toolName: string;
    arguments: Record<string, any>;
    dependsOn: string[];
    rationale: string;
    status: StepStatus;
    result?: string;
    error?: string;
    retryCount: number;
    maxRetries: number;
}

export interface MCPExecutionPlan {
    planId: string;
    query: string;
    createdAt: number;
    steps: MCPPlanStep[];
}

export interface MCPExecutionLedger {
    plan: MCPExecutionPlan;
    completedSteps: string[];
    failedSteps: string[];
    skippedSteps: string[];
    synthesisAttempts: number;
}

export interface ModelEntry {
    provider: Provider;
    modelId: string;
    modelName: string;
    tokenLimit: number;
}

export interface LedgerExecutorOptions {
    toolChunkSize?: number;        // Max tools per chunk (default: based on TPM)
    providerCooldownMs?: number;   // Cooldown for rate limits (default: 35000)
    stepTimeoutMs?: number;        // Timeout per step (default: 30000)
    maxRetriesPerStep?: number;    // Retries per failed step (default: 2)
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum number of synthesis attempts across the entire fallback chain.
 *  Set high enough to exhaust all available models — the chain already
 *  skips models whose TPM is below the estimated synthesis payload, so
 *  this cap is just a safety net against infinite loops, not a quality gate.
 */
export const MAX_SYNTHESIS_ATTEMPTS = 50;

/** Default per-step retry limit for transient tool failures. */
export const DEFAULT_MAX_RETRIES = 2;

/** Default provider cooldown in ms for rate limit (429) errors. */
export const DEFAULT_PROVIDER_COOLDOWN_MS = 35_000;

/** Default step timeout in ms. */
export const DEFAULT_STEP_TIMEOUT_MS = 30_000;

// ─── Planning Fallback ───────────────────────────────────────────────────────

/**
 * Creates a fallback plan that includes all provided tools with no dependencies.
 * Used when the planning LLM call fails or returns unparseable output.
 */
export function buildFallbackPlan(
    query: string,
    mcpTools: any[]
): MCPExecutionPlan {
    const steps: MCPPlanStep[] = mcpTools.map((tool, idx) => {
        const toolName = tool.function?.name || tool.name || `tool_${idx}`;
        return {
            stepId: `step_${idx + 1}`,
            toolName,
            arguments: {},
            dependsOn: [],
            rationale: 'fallback: planning phase unavailable',
            status: 'pending',
            retryCount: 0,
            maxRetries: DEFAULT_MAX_RETRIES
        };
    });

    return {
        planId: `plan_fallback_${Date.now()}`,
        query,
        createdAt: Date.now(),
        steps
    };
}

// ─── Ledger factory ───────────────────────────────────────────────────────────

export function createLedger(plan: MCPExecutionPlan): MCPExecutionLedger {
    return {
        plan,
        completedSteps: [],
        failedSteps: [],
        skippedSteps: [],
        synthesisAttempts: 0
    };
}

// ─── Synthesis message builder ────────────────────────────────────────────────

/**
 * Builds the messages array for the synthesis LLM call from the ledger.
 * Replaces the old buildSynthesisMessages() text-dump approach with
 * structured, per-step output that preserves semantic relationships.
 */
export function buildSynthesisFromLedger(
    ledger: MCPExecutionLedger,
    query: string,
    systemPrompt: string
): any[] {
    const { plan } = ledger;

    let resultsBlock = '## Tool Execution Results\n\n';
    let hasAnyResult = false;

    for (const step of plan.steps) {
        if (step.status === 'completed') {
            resultsBlock += `### ${step.toolName}\nRationale: ${step.rationale}\n\n${step.result || '(empty output)'}\n\n`;
            hasAnyResult = true;
        } else if (step.status === 'failed') {
            resultsBlock += `### ${step.toolName} — FAILED\nError: ${step.error}\n\n`;
        } else if (step.status === 'skipped') {
            resultsBlock += `### ${step.toolName} — SKIPPED\nReason: ${step.error || 'prerequisite failed'}\n\n`;
        }
    }

    if (!hasAnyResult) {
        resultsBlock += '_No tool results available._\n\n';
    }

    return [
        { role: 'system', content: systemPrompt },
        {
            role: 'user',
            content:
                `${query}\n\n` +
                resultsBlock +
                `\nAll tools have been executed. Using the results above, provide a complete and direct answer to the original question.\n\nCRITICAL INSTRUCTION: The user CANNOT see the tool execution results. You MUST embed all relevant information, including full URLs, markdown images (e.g., ![Title](url)), and data points directly into your final answer. Do NOT use placeholders, and do NOT refer the user to "the tool results".`
        }
    ];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function markDependentsSkipped(
    steps: MCPPlanStep[],
    failedStepId: string,
    ledger: MCPExecutionLedger
): void {
    for (const step of steps) {
        if (step.status === 'pending' && step.dependsOn.includes(failedStepId)) {
            step.status = 'skipped';
            step.error = `Skipped: dependency "${failedStepId}" failed`;
            ledger.skippedSteps.push(step.stepId);
            // Recursively skip dependents of this skipped step
            markDependentsSkipped(steps, step.stepId, ledger);
        }
    }
}

function hasCircularDependency(steps: MCPPlanStep[]): boolean {
    const visited = new Set<string>();
    const inStack = new Set<string>();

    function dfs(stepId: string): boolean {
        if (inStack.has(stepId)) return true;
        if (visited.has(stepId)) return false;
        visited.add(stepId);
        inStack.add(stepId);
        const step = steps.find(s => s.stepId === stepId);
        for (const dep of step?.dependsOn || []) {
            if (dfs(dep)) return true;
        }
        inStack.delete(stepId);
        return false;
    }

    for (const step of steps) {
        if (dfs(step.stepId)) return true;
    }
    return false;
}
