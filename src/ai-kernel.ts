// Copyright (c) JupyterLite Contributors
// Distributed under the terms of the Modified BSD License.

import type { PartialJSONObject } from '@lumino/coreutils';

import type { KernelMessage } from '@jupyterlab/services';
import type * as nbformat from '@jupyterlab/nbformat';
import {
  nullTranslator,
  type TranslationBundle
} from '@jupyterlab/translation';

import { BaseKernel, type IKernel } from '@jupyterlite/services';

// Import types from internal paths since @jupyterlite/ai doesn't export them publicly
// TODO: Upstream should export these types from the main entry point
import type { AgentManager, IAgentEvent } from '@jupyterlite/ai/lib/agent';

import type {
  IToolCallMetadata,
  ToolCallStatus
} from 'jupyter-chat-components';
import { buildToolCallHtml } from 'jupyter-chat-components/lib/tool-call';

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
    this._trans = nullTranslator.load('jupyterlab');

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
        text: `${this._trans.__('Error: AI provider not configured. Check your API key in the JupyterLite AI settings.')}\n`
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

    const html = this._buildToolCallHtml({
      toolName: data.toolName,
      input: data.input,
      status: 'pending',
      summary
    });

    const text = Private.buildToolCallText({
      toolName: data.toolName,
      input: data.input,
      status: 'pending',
      summary,
      trans: this._trans
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
    outputData: unknown;
    isError: boolean;
  }): void {
    const context = this._toolContexts.get(data.callId);
    const output = Private.formatToolOutput(data.outputData);

    // Handle display_data tool specially - emit MIME bundle instead of tool card
    if (data.toolName === DISPLAY_DATA_TOOL_NAME && !data.isError && output) {
      this._handleDisplayDataToolComplete({ ...data, output }, context);
      return;
    }

    if (context) {
      const status: ToolCallStatus = data.isError ? 'error' : 'completed';

      const html = this._buildToolCallHtml({
        toolName: context.toolName,
        input: context.input,
        status,
        summary: context.summary,
        output
      });

      const text = Private.buildToolCallText({
        toolName: context.toolName,
        input: context.input,
        status,
        summary: context.summary,
        output,
        trans: this._trans
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
          text: `${this._trans.__('Tool %1 failed: %2', data.toolName, output ?? '')}\n`
        });
      } else {
        this.stream({
          name: 'stdout',
          text: `${this._trans.__('Tool %1 completed', data.toolName)}\n`
        });
      }
    }
  }

  /**
   * Build tool call HTML string using the shared component.
   */
  private _buildToolCallHtml(options: IToolCallMetadata): string {
    return buildToolCallHtml({
      ...options,
      trans: this._trans,
      toolCallApproval: null
    }).outerHTML;
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
      const errorMessage = this._trans.__(
        'Failed to parse display_data output (%1)',
        reason
      );

      if (context) {
        const html = this._buildToolCallHtml({
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
          output: errorMessage,
          trans: this._trans
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
  private _trans: TranslationBundle;
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
   * Format tool output data to a string for display.
   */
  export function formatToolOutput(outputData: unknown): string | undefined {
    if (outputData === undefined || outputData === null) {
      return undefined;
    }
    if (typeof outputData === 'string') {
      return outputData;
    }
    try {
      return JSON.stringify(outputData, null, 2);
    } catch {
      return '[Complex object - cannot serialize]';
    }
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
   * Options for building plain text tool call output.
   */
  interface IToolCallTextOptions {
    toolName: string;
    input: string;
    status: ToolCallStatus;
    summary?: string;
    output?: string;
    trans: TranslationBundle;
  }

  /**
   * Get the translated status text for a tool call status.
   */
  const getStatusText = (
    status: ToolCallStatus,
    trans: TranslationBundle
  ): string => {
    switch (status) {
      case 'pending':
        return trans.__('Running...');
      case 'awaiting_approval':
        return trans.__('Awaiting Approval');
      case 'approved':
        return trans.__('Approved');
      case 'rejected':
        return trans.__('Rejected');
      case 'completed':
        return trans.__('Completed');
      case 'error':
        return trans.__('Error');
    }
  };

  /**
   * Build plain text fallback for tool call display.
   */
  export function buildToolCallText(options: IToolCallTextOptions): string {
    const { toolName, input, status, summary, output, trans } = options;
    const statusText = getStatusText(status, trans);
    const summaryText = summary ? ` ${summary}` : '';
    let text = `[${trans.__('Tool: %1', toolName)}${summaryText}] (${statusText})\n${trans.__('Input')}: ${input}`;
    if (output !== undefined) {
      const label = status === 'error' ? trans.__('Error') : trans.__('Result');
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
