// Copyright (c) JupyterLite Contributors
// Distributed under the terms of the Modified BSD License.

import type { PartialJSONObject } from '@lumino/coreutils';

import type { KernelMessage } from '@jupyterlab/services';
import type * as nbformat from '@jupyterlab/nbformat';

import { BaseKernel, type IKernel } from '@jupyterlite/services';

// Import types from internal paths since @jupyterlite/ai doesn't export them publicly
// TODO: Upstream should export these types from the main entry point
import type { AgentManager, IAgentEvent } from '@jupyterlite/ai/lib/agent';

import { DISPLAY_DATA_TOOL_NAME } from './tools';

const AI_KERNEL_PROMPT_SUFFIX = [
  '---',
  'AI kernel context:',
  '- You are responding in a JupyterLab AI kernel cell output.',
  '- Output appears as cell output; respond in Markdown.',
  '- Use the display_data tool to emit rich MIME outputs when helpful.',
  '- If you use display_data, do not repeat the same payload in Markdown.',
  '- Avoid chat or sidebar UI references.'
].join('\n');

/**
 * Tool call status type.
 */
type ToolStatus = 'pending' | 'completed' | 'error';

/**
 * Stored context for an active tool call.
 */
interface IToolCallContext {
  displayId: string;
  toolName: string;
  input: string;
  summary: string;
}

/**
 * Options for creating an AIKernel.
 */
export interface IAIKernelOptions extends IKernel.IOptions {
  /**
   * The agent manager to use for generating responses.
   */
  agentManager: AgentManager;

  /**
   * The display name of the provider.
   */
  providerName: string;

  /**
   * The model name.
   */
  modelName: string;
}

/**
 * A kernel that sends prompts to an AI provider and streams responses.
 */
export class AIKernel extends BaseKernel {
  constructor(options: IAIKernelOptions) {
    super(options);
    this._agentManager = options.agentManager;
    this._providerName = options.providerName;
    this._modelName = options.modelName;

    // Bind event handler to this instance
    this._handleAgentEvent = this._handleAgentEvent.bind(this);
  }

  /**
   * Handle a kernel_info_request message
   */
  async kernelInfoRequest(): Promise<KernelMessage.IInfoReplyMsg['content']> {
    const content: KernelMessage.IInfoReply = {
      implementation: 'AI',
      implementation_version: '0.1.0',
      language_info: {
        codemirror_mode: {
          name: 'markdown'
        },
        file_extension: '.md',
        mimetype: 'text/markdown',
        name: 'markdown',
        nbconvert_exporter: 'markdown',
        pygments_lexer: 'markdown',
        version: '1.0'
      },
      protocol_version: '5.3',
      status: 'ok',
      banner: `AI Kernel - ${this._providerName} (${this._modelName})`,
      help_links: [
        {
          text: 'JupyterLite AI',
          url: 'https://github.com/jupyterlite/jupyterlite-ai'
        }
      ]
    };
    return content;
  }

  /**
   * Handle an `execute_request` message.
   *
   * @param content The content of the request.
   */
  async executeRequest(
    content: KernelMessage.IExecuteRequestMsg['content']
  ): Promise<KernelMessage.IExecuteReplyMsg['content']> {
    const { code } = content;
    this._resetExecutionState();

    // Handle empty input
    if (!code.trim()) {
      return {
        status: 'ok',
        execution_count: this.executionCount,
        user_expressions: {}
      };
    }

    // Check if the provider is properly configured
    if (!this._agentManager.hasValidConfig()) {
      this.stream({
        name: 'stderr',
        text: 'Error: AI provider not configured. Check your API key in the JupyterLite AI settings.\n'
      });
      return {
        status: 'error',
        execution_count: this.executionCount,
        ename: 'ConfigurationError',
        evalue: 'AI provider not configured',
        traceback: []
      };
    }

    try {
      // Connect to streaming events
      this._agentManager.agentEvent.connect(this._handleAgentEvent, this);

      const prompt = `${code}\n\n${AI_KERNEL_PROMPT_SUFFIX}`;

      // Generate the response
      await this._agentManager.generateResponse(prompt);

      if (this._executionErrorMessage) {
        return {
          status: 'error',
          execution_count: this.executionCount,
          ename: 'AIError',
          evalue: this._executionErrorMessage,
          traceback: []
        };
      }

      return {
        status: 'ok',
        execution_count: this.executionCount,
        user_expressions: {}
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.stream({
        name: 'stderr',
        text: `Error: ${errorMessage}\n`
      });
      return {
        status: 'error',
        execution_count: this.executionCount,
        ename: 'AIError',
        evalue: errorMessage,
        traceback: []
      };
    } finally {
      // Flush any buffered post-display_data text before clearing execution state.
      this._flushPostDisplayDataTextBuffer();

      // Always disconnect the event handler and reset state
      this._agentManager.agentEvent.disconnect(this._handleAgentEvent, this);
      this._resetExecutionState();
    }
  }

  /**
   * Handle agent events (streaming chunks and errors).
   */
  private _handleAgentEvent(sender: AgentManager, event: IAgentEvent): void {
    switch (event.type) {
      case 'message_chunk':
        this._handleMessageChunk(event.data.chunk);
        break;
      case 'error':
        if (!this._executionErrorMessage) {
          this._executionErrorMessage = event.data.error.message;
        }
        this.stream({
          name: 'stderr',
          text: `Error: ${event.data.error.message}\n`
        });
        break;
      case 'tool_call_start':
        this._handleToolCallStart(event.data);
        break;
      case 'tool_call_complete':
        this._handleToolCallComplete(event.data);
        break;
      case 'tool_approval_request':
        this._handleToolApprovalRequest(event.data);
        break;
    }
  }

  /**
   * Handle a message chunk by updating the markdown display.
   */
  private _handleMessageChunk(chunk: string): void {
    // Suppress markdown echoes when a display_data output already rendered rich content.
    if (this._suppressPostDisplayDataText) {
      return;
    }

    if (this._bufferPostDisplayDataText) {
      this._postDisplayDataTextBuffer += chunk;

      if (
        Private.shouldSuppressPostDisplayDataText(
          this._postDisplayDataTextBuffer
        )
      ) {
        this._postDisplayDataTextBuffer = '';
        this._bufferPostDisplayDataText = false;
        this._suppressPostDisplayDataText = true;
      }
      return;
    }

    this._renderMessageChunk(chunk);
  }

  /**
   * Render a message chunk in the markdown output area.
   */
  private _renderMessageChunk(chunk: string): void {
    // If no display ID exists, create a new one (happens at start or after tool calls)
    if (!this._responseDisplayId) {
      this._responseDisplayId = `response-${this._displayIdCounter++}`;
      this._responseContent = '';
    }

    const isFirstChunk = this._responseContent === '';
    this._responseContent += chunk;

    const content = {
      data: {
        'text/markdown': this._responseContent,
        'text/plain': this._responseContent
      },
      metadata: {},
      transient: {
        display_id: this._responseDisplayId
      }
    };

    if (isFirstChunk) {
      this.displayData(content);
    } else {
      this.updateDisplayData(content);
    }
  }

  /**
   * Handle tool call start event by displaying a rich HTML card.
   */
  private _handleToolCallStart(data: {
    callId: string;
    toolName: string;
    input: string;
  }): void {
    // Finalize and reset any buffered post-display_data text before starting a new tool card.
    this._flushPostDisplayDataTextBuffer();
    this._resetPostDisplayDataTextState();

    // Reset text display so any subsequent text chunks create a new display
    // This ensures proper chronological ordering: text -> tool -> text -> tool -> ...
    this._responseDisplayId = null;
    this._responseContent = '';

    const displayId = `tool-call-${this._displayIdCounter++}`;
    const summary = Private.extractToolSummary(data.toolName, data.input);

    // Store the context for later update
    this._toolContexts.set(data.callId, {
      displayId,
      toolName: data.toolName,
      input: data.input,
      summary
    });

    const html = Private.buildToolCallHtml({
      toolName: data.toolName,
      input: data.input,
      status: 'pending',
      summary
    });

    const text = Private.buildToolCallText({
      toolName: data.toolName,
      input: data.input,
      status: 'pending',
      summary
    });

    this.displayData({
      data: {
        'text/html': html,
        'text/plain': text
      },
      metadata: {},
      transient: {
        display_id: displayId
      }
    });
  }

  /**
   * Handle tool call complete event by updating the display.
   */
  private _handleToolCallComplete(data: {
    callId: string;
    toolName: string;
    output: string;
    isError: boolean;
  }): void {
    const context = this._toolContexts.get(data.callId);

    // Handle display_data tool specially - emit MIME bundle instead of tool card
    if (data.toolName === DISPLAY_DATA_TOOL_NAME && !data.isError) {
      this._handleDisplayDataToolComplete(data, context);
      return;
    }

    if (context) {
      const status: ToolStatus = data.isError ? 'error' : 'completed';

      const html = Private.buildToolCallHtml({
        toolName: context.toolName,
        input: context.input,
        status,
        summary: context.summary,
        output: data.output
      });

      const text = Private.buildToolCallText({
        toolName: context.toolName,
        input: context.input,
        status,
        summary: context.summary,
        output: data.output
      });

      this.updateDisplayData({
        data: {
          'text/html': html,
          'text/plain': text
        },
        metadata: {},
        transient: {
          display_id: context.displayId
        }
      });

      // Clean up the context
      this._toolContexts.delete(data.callId);
    } else {
      // Fallback if context is not found
      if (data.isError) {
        this.stream({
          name: 'stderr',
          text: `[Tool ${data.toolName} failed: ${data.output}]\n`
        });
      } else {
        this.stream({
          name: 'stdout',
          text: `[Tool ${data.toolName} completed]\n`
        });
      }
    }
  }

  /**
   * Handle tool approval requests by auto-approving in AI kernels.
   *
   * The kernel output model does not currently expose interactive approve/reject
   * controls, so we resolve approval requests immediately to avoid hanging.
   */
  private _handleToolApprovalRequest(data: { approvalId: string }): void {
    this._agentManager.approveToolCall(
      data.approvalId,
      'Auto-approved in AI kernel'
    );
  }

  /**
   * Handle display_data tool completion by emitting a MIME bundle.
   */
  private _handleDisplayDataToolComplete(
    data: {
      callId: string;
      toolName: string;
      output: string;
      isError: boolean;
    },
    context: IToolCallContext | undefined
  ): void {
    let mimeBundle: nbformat.IMimeBundle;
    let metadata: PartialJSONObject;

    try {
      const parsedOutput = Private.parseDisplayDataToolOutput(data.output);
      mimeBundle = parsedOutput.mimeBundle;
      metadata = parsedOutput.metadata;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const errorMessage = `Failed to parse display_data output (${reason})`;

      if (context) {
        const html = Private.buildToolCallHtml({
          toolName: context.toolName,
          input: context.input,
          status: 'error',
          summary: context.summary,
          output: errorMessage
        });

        const text = Private.buildToolCallText({
          toolName: context.toolName,
          input: context.input,
          status: 'error',
          summary: context.summary,
          output: errorMessage
        });

        this.updateDisplayData({
          data: {
            'text/html': html,
            'text/plain': text
          },
          metadata: {},
          transient: {
            display_id: context.displayId
          }
        });

        this._toolContexts.delete(data.callId);
      }

      this.stream({
        name: 'stderr',
        text: `Error: ${errorMessage}\n`
      });
      return;
    }

    // Update the existing tool card display to show the MIME content,
    // or create a new display if no context exists
    const displayId =
      context?.displayId || `display-${this._displayIdCounter++}`;

    const displayContent = {
      data: mimeBundle,
      metadata,
      transient: {
        display_id: displayId
      }
    };

    if (context) {
      // Replace the tool card with the MIME content
      this.updateDisplayData(displayContent);
      this._toolContexts.delete(data.callId);
    } else {
      // Create new display
      this.displayData(displayContent);
    }

    // Buffer any subsequent text chunks to detect and suppress duplicate payload echoes.
    this._bufferPostDisplayDataText = true;
    this._suppressPostDisplayDataText = false;
    this._postDisplayDataTextBuffer = '';
  }

  /**
   * Handle a complete_request message.
   *
   * @param content The content of the request.
   */
  async completeRequest(
    content: KernelMessage.ICompleteRequestMsg['content']
  ): Promise<KernelMessage.ICompleteReplyMsg['content']> {
    return {
      matches: [],
      cursor_start: content.cursor_pos,
      cursor_end: content.cursor_pos,
      metadata: {},
      status: 'ok'
    };
  }

  /**
   * Handle an `inspect_request` message.
   *
   * @param content The content of the request.
   */
  async inspectRequest(
    content: KernelMessage.IInspectRequestMsg['content']
  ): Promise<KernelMessage.IInspectReplyMsg['content']> {
    return {
      status: 'ok',
      found: false,
      data: {},
      metadata: {}
    };
  }

  /**
   * Handle an `is_complete_request` message.
   *
   * @param content The content of the request.
   */
  async isCompleteRequest(
    content: KernelMessage.IIsCompleteRequestMsg['content']
  ): Promise<KernelMessage.IIsCompleteReplyMsg['content']> {
    return {
      status: 'complete'
    };
  }

  /**
   * Handle a `comm_info_request` message.
   *
   * @param content The content of the request.
   */
  async commInfoRequest(
    content: KernelMessage.ICommInfoRequestMsg['content']
  ): Promise<KernelMessage.ICommInfoReplyMsg['content']> {
    return {
      status: 'ok',
      comms: {}
    };
  }

  /**
   * Send an `input_reply` message.
   *
   * @param content The content of the reply.
   */
  inputReply(content: KernelMessage.IInputReplyMsg['content']): void {
    // Input is not supported
  }

  /**
   * Send a `comm_open` message.
   *
   * @param msg The comm_open message.
   */
  async commOpen(msg: KernelMessage.ICommOpenMsg): Promise<void> {
    // Comms are not supported
  }

  /**
   * Send a `comm_msg` message.
   *
   * @param msg The comm_msg message.
   */
  async commMsg(msg: KernelMessage.ICommMsgMsg): Promise<void> {
    // Comms are not supported
  }

  /**
   * Send a `comm_close` message.
   *
   * @param msg The comm_close message.
   */
  async commClose(msg: KernelMessage.ICommCloseMsg): Promise<void> {
    // Comms are not supported
  }

  private _agentManager: AgentManager;
  private _providerName: string;
  private _modelName: string;
  private _toolContexts: Map<string, IToolCallContext> = new Map();
  private _displayIdCounter = 0;
  private _responseDisplayId: string | null = null;
  private _responseContent = '';
  private _executionErrorMessage: string | null = null;
  private _bufferPostDisplayDataText = false;
  private _suppressPostDisplayDataText = false;
  private _postDisplayDataTextBuffer = '';

  private _flushPostDisplayDataTextBuffer(): void {
    if (!this._bufferPostDisplayDataText) {
      return;
    }

    if (
      !this._suppressPostDisplayDataText &&
      this._postDisplayDataTextBuffer.trim()
    ) {
      this._renderMessageChunk(this._postDisplayDataTextBuffer);
    }

    this._bufferPostDisplayDataText = false;
    this._postDisplayDataTextBuffer = '';
  }

  private _resetPostDisplayDataTextState(): void {
    this._bufferPostDisplayDataText = false;
    this._suppressPostDisplayDataText = false;
    this._postDisplayDataTextBuffer = '';
  }

  private _resetExecutionState(): void {
    this._responseDisplayId = null;
    this._responseContent = '';
    this._executionErrorMessage = null;
    this._resetPostDisplayDataTextState();
    this._toolContexts.clear();
  }
}

/**
 * Namespace for private helper functions.
 */
namespace Private {
  /**
   * Escape HTML special characters to prevent XSS.
   */
  export function escapeHtml(value: string): string {
    if (typeof document !== 'undefined') {
      const node = document.createElement('span');
      node.textContent = value;
      return node.innerHTML;
    }
    // Fallback for non-browser environments
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Extracts a human-readable summary from tool input for display in the header.
   * @param toolName The name of the tool being called
   * @param input The formatted JSON input string
   * @returns A short summary string or empty string if none available
   */
  export function extractToolSummary(toolName: string, input: string): string {
    const extractCommandId = (value: unknown): string | null => {
      if (typeof value === 'string') {
        const match = value.match(/"commandId"\s*:\s*"([^"]+)"/);
        return match ? match[1] : null;
      }
      if (value && typeof value === 'object' && 'commandId' in value) {
        const { commandId } = value as { commandId?: unknown };
        return typeof commandId === 'string' ? commandId : null;
      }
      return null;
    };

    try {
      const parsedInput = JSON.parse(input);

      switch (toolName) {
        case 'execute_command':
          {
            const commandId =
              extractCommandId(parsedInput) ?? extractCommandId(input);
            if (commandId) {
              return commandId;
            }
          }
          break;
        case 'discover_commands':
          if (parsedInput.query) {
            return `query: "${parsedInput.query}"`;
          }
          break;
      }
    } catch {
      if (toolName === 'execute_command') {
        const commandId = extractCommandId(input);
        if (commandId) {
          return commandId;
        }
      }
    }
    return '';
  }

  /**
   * CSS configuration for different tool statuses.
   */
  const STATUS_CONFIG: Record<
    ToolStatus,
    { cssClass: string; statusClass: string; statusText: string }
  > = {
    pending: {
      cssClass: 'jp-ai-tool-pending',
      statusClass: 'jp-ai-tool-status-pending',
      statusText: 'Running...'
    },
    completed: {
      cssClass: 'jp-ai-tool-completed',
      statusClass: 'jp-ai-tool-status-completed',
      statusText: 'Completed'
    },
    error: {
      cssClass: 'jp-ai-tool-error',
      statusClass: 'jp-ai-tool-status-error',
      statusText: 'Error'
    }
  };

  /**
   * Inline CSS styles for tool call display.
   * These are embedded in the HTML to ensure proper styling in any context.
   */
  const TOOL_CALL_STYLES = `
<style>
.jp-ai-tool-call {
  margin: 8px 0;
  border: 1px solid var(--jp-border-color1, #e0e0e0);
  border-radius: 6px;
  background: var(--jp-layout-color0, #fff);
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
  overflow: hidden;
  font-family: var(--jp-ui-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
}
.jp-ai-tool-header {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  background: var(--jp-layout-color1, #f5f5f5);
  cursor: pointer;
  user-select: none;
  gap: 8px;
}
.jp-ai-tool-header:hover {
  background: var(--jp-layout-color2, #eee);
}
.jp-ai-tool-header::marker {
  content: '';
}
.jp-ai-tool-header::before {
  content: '';
  width: 0;
  height: 0;
  border-left: 5px solid var(--jp-ui-font-color2, #666);
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  transition: transform 0.2s ease;
}
.jp-ai-tool-call[open] .jp-ai-tool-header::before {
  transform: rotate(90deg);
}
.jp-ai-tool-icon {
  font-size: 14px;
  opacity: 0.8;
}
.jp-ai-tool-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--jp-ui-font-color1, #333);
  flex: 1;
}
.jp-ai-tool-summary {
  font-weight: 400;
  opacity: 0.7;
  font-size: 12px;
}
.jp-ai-tool-summary::before {
  content: ' ';
  white-space: pre;
}
.jp-ai-tool-status {
  font-size: 11px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 3px;
}
.jp-ai-tool-status-pending {
  background: rgba(255, 152, 0, 0.15);
  color: #e65100;
}
.jp-ai-tool-status-completed {
  background: rgba(76, 175, 80, 0.15);
  color: #2e7d32;
}
.jp-ai-tool-status-error {
  background: rgba(244, 67, 54, 0.15);
  color: #c62828;
}
.jp-ai-tool-body {
  padding: 12px;
}
.jp-ai-tool-section {
  margin-bottom: 8px;
}
.jp-ai-tool-section:last-child {
  margin-bottom: 0;
}
.jp-ai-tool-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--jp-ui-font-color2, #666);
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.jp-ai-tool-code {
  background: var(--jp-layout-color2, #f5f5f5);
  border: 1px solid var(--jp-border-color1, #e0e0e0);
  border-radius: 4px;
  padding: 8px;
  margin: 0;
  font-family: var(--jp-code-font-family, 'SFMono-Regular', Consolas, monospace);
  font-size: 12px;
  line-height: 1.4;
  overflow: auto;
  max-height: 200px;
  white-space: pre-wrap;
  word-break: break-word;
}
.jp-ai-tool-code code {
  background: none;
  padding: 0;
  border: none;
  font-family: inherit;
  font-size: inherit;
}
.jp-ai-tool-pending {
  border-left: 4px solid #ff9800;
}
.jp-ai-tool-completed {
  border-left: 4px solid #4caf50;
}
.jp-ai-tool-error {
  border-left: 4px solid #f44336;
}
</style>`;

  /**
   * Options for building tool call HTML.
   */
  interface IToolCallHtmlOptions {
    toolName: string;
    input: string;
    status: ToolStatus;
    summary?: string;
    output?: string;
  }

  /**
   * Builds HTML for a tool call display.
   */
  export function buildToolCallHtml(options: IToolCallHtmlOptions): string {
    const { toolName, input, status, summary, output } = options;
    const config = STATUS_CONFIG[status];
    const escapedToolName = escapeHtml(toolName);
    const escapedInput = escapeHtml(input);
    const summaryHtml = summary
      ? `<span class="jp-ai-tool-summary">${escapeHtml(summary)}</span>`
      : '';

    let bodyContent = `
<div class="jp-ai-tool-section">
<div class="jp-ai-tool-label">Input</div>
<pre class="jp-ai-tool-code"><code>${escapedInput}</code></pre>
</div>`;

    // Add output/result section if provided
    if (output !== undefined) {
      const escapedOutput = escapeHtml(output);
      const label = status === 'error' ? 'Error' : 'Result';
      bodyContent += `
<div class="jp-ai-tool-section">
<div class="jp-ai-tool-label">${label}</div>
<pre class="jp-ai-tool-code"><code>${escapedOutput}</code></pre>
</div>`;
    }

    return `${TOOL_CALL_STYLES}
<details class="jp-ai-tool-call ${config.cssClass}">
<summary class="jp-ai-tool-header">
<div class="jp-ai-tool-icon">⚡</div>
<div class="jp-ai-tool-title">${escapedToolName}${summaryHtml}</div>
<div class="jp-ai-tool-status ${config.statusClass}">${config.statusText}</div>
</summary>
<div class="jp-ai-tool-body">${bodyContent}
</div>
</details>`;
  }

  /**
   * Build plain text fallback for tool call display.
   */
  export function buildToolCallText(options: IToolCallHtmlOptions): string {
    const { toolName, input, status, summary, output } = options;
    const config = STATUS_CONFIG[status];
    const summaryText = summary ? ` ${summary}` : '';
    let text = `[Tool: ${toolName}${summaryText}] (${config.statusText})\nInput: ${input}`;
    if (output !== undefined) {
      const label = status === 'error' ? 'Error' : 'Result';
      text += `\n${label}: ${output}`;
    }
    return text;
  }

  /**
   * Detect when post-display_data markdown appears to repeat raw payload content.
   */
  export function shouldSuppressPostDisplayDataText(value: string): boolean {
    const trimmed = value.trimStart();
    if (!trimmed) {
      return false;
    }

    // Markdown fenced blocks are commonly used by models to echo payloads.
    if (trimmed.startsWith('```') || value.includes('```')) {
      return true;
    }

    // Raw JSON-like output should be suppressed once rich renderers handled it.
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return true;
    }

    return /\n\s*[[{]\s*\n\s*"[^"]+"\s*:/.test(value);
  }

  interface IParsedDisplayDataToolOutput {
    mimeBundle: nbformat.IMimeBundle;
    metadata: PartialJSONObject;
  }

  export function parseDisplayDataToolOutput(
    output: string
  ): IParsedDisplayDataToolOutput {
    const parsed = JSON.parse(output) as unknown;
    if (!isPlainObject(parsed)) {
      throw new Error('Expected an object');
    }

    const metadata = isPlainObject(parsed.metadata)
      ? (parsed.metadata as PartialJSONObject)
      : {};

    const rawMimeType =
      typeof parsed.mime_type === 'string' ? parsed.mime_type.trim() : '';

    // Legacy shape: { mime_type: "text/html", data: "<b>...</b>" }
    if (rawMimeType) {
      if (!('data' in parsed)) {
        throw new Error('Missing "data" for single MIME payload');
      }
      const mimeBundle = createSingleMimeBundle(rawMimeType, parsed.data);
      return { mimeBundle, metadata };
    }

    // Full bundle shape: { data: { "text/latex": "...", "text/plain": "..." } }
    let bundleCandidate = parsed.data;
    if (typeof bundleCandidate === 'string') {
      bundleCandidate = parseJsonString(bundleCandidate);
    }
    if (!isPlainObject(bundleCandidate)) {
      throw new Error('Expected "data" to be a MIME bundle object');
    }

    const mimeBundle = normalizeMimeBundle(bundleCandidate);
    if (!Object.keys(mimeBundle).length) {
      throw new Error('MIME bundle is empty');
    }

    if (!('text/plain' in mimeBundle)) {
      mimeBundle['text/plain'] = deriveTextFallback(mimeBundle);
    }

    return {
      mimeBundle,
      metadata
    };
  }

  const createSingleMimeBundle = (
    mimeType: string,
    value: unknown
  ): nbformat.IMimeBundle => {
    const normalizedValue = normalizeMimeValue(mimeType, value);
    const mimeBundle: nbformat.IMimeBundle = {
      [mimeType]: normalizedValue
    };
    if (mimeType !== 'text/plain') {
      mimeBundle['text/plain'] = toTextFallback(normalizedValue);
    }
    return mimeBundle;
  };

  const normalizeMimeBundle = (
    bundle: Record<string, unknown>
  ): nbformat.IMimeBundle => {
    const normalized: nbformat.IMimeBundle = {};
    for (const [rawMimeType, value] of Object.entries(bundle)) {
      const mimeType = rawMimeType.trim();
      if (!mimeType) {
        continue;
      }
      normalized[mimeType] = normalizeMimeValue(mimeType, value);
    }
    return normalized;
  };

  const normalizeMimeValue = (
    mimeType: string,
    value: unknown
  ): nbformat.MultilineString | PartialJSONObject => {
    if (isJsonMimeType(mimeType)) {
      return coerceJsonMimeValue(value);
    }
    return coerceMimeValue(value);
  };

  const coerceJsonMimeValue = (
    value: unknown
  ): nbformat.MultilineString | PartialJSONObject => {
    // Parse JSON strings when possible, but preserve structured JSON arrays/scalars.
    const parsed = typeof value === 'string' ? parseJsonString(value) : value;

    if (isPlainObject(parsed)) {
      return parsed as PartialJSONObject;
    }

    if (Array.isArray(parsed) || isJsonPrimitive(parsed)) {
      return parsed as unknown as PartialJSONObject;
    }

    return coerceMimeValue(parsed);
  };

  const coerceMimeValue = (
    value: unknown
  ): nbformat.MultilineString | PartialJSONObject => {
    if (typeof value === 'string') {
      return value;
    }

    if (isStringArray(value)) {
      return value;
    }

    if (isPlainObject(value)) {
      return value as PartialJSONObject;
    }

    // Fall back to a string for scalars and unsupported top-level structures.
    return toTextFallback(value);
  };

  const deriveTextFallback = (mimeBundle: nbformat.IMimeBundle): string => {
    // Prefer any text/* MIME already present, otherwise use the first bundle entry.
    for (const [mimeType, value] of Object.entries(mimeBundle)) {
      if (mimeType.startsWith('text/')) {
        return toTextFallback(value);
      }
    }

    const firstValue = Object.values(mimeBundle)[0];
    return toTextFallback(firstValue);
  };

  const toTextFallback = (value: unknown): string => {
    if (typeof value === 'string') {
      return value;
    }

    if (isStringArray(value)) {
      return value.join('');
    }

    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  };

  const parseJsonString = (value: string): unknown => {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  };

  const isJsonMimeType = (mimeType: string): boolean => {
    return mimeType === 'application/json' || mimeType.endsWith('+json');
  };

  const isJsonPrimitive = (
    value: unknown
  ): value is null | string | number | boolean => {
    return (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    );
  };

  const isPlainObject = (value: unknown): value is Record<string, unknown> => {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  };

  const isStringArray = (value: unknown): value is string[] => {
    return (
      Array.isArray(value) && value.every(item => typeof item === 'string')
    );
  };
}
