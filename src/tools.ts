// Copyright (c) JupyterLite Contributors
// Distributed under the terms of the Modified BSD License.

/**
 * Tools for the AI kernel.
 *
 * NOTE: These tools are implemented here for now but may be upstreamed
 * to @jupyterlite/ai in the future to be available to all AI agents.
 */

import { tool } from 'ai';
import { z } from 'zod';

import type { ITool } from '@jupyterlite/ai';

/**
 * The name of the display_data tool.
 */
export const DISPLAY_DATA_TOOL_NAME = 'display_data';

/**
 * Create a tool that allows the LLM to output rich MIME data.
 *
 * This tool enables the AI to display data using JupyterLab's MIME renderers
 * instead of just returning text. For example, the AI can output JSON data
 * that will be rendered with JupyterLab's JSON viewer, or HTML that will
 * be rendered as rich HTML output.
 *
 * The tool execution returns the data, which is then intercepted by the
 * AIKernel to emit a proper display_data message with the MIME bundle.
 *
 * @param mimeTypes - Optional list of available MIME types from the rendermime registry.
 */
export function createDisplayDataTool(
  mimeTypes?: ReadonlyArray<string>
): ITool {
  // Build description with available MIME types if provided
  const mimeTypesList = mimeTypes?.length
    ? `Available MIME types: ${mimeTypes.join(', ')}`
    : 'Use standard MIME types (e.g., application/json, text/html, image/png, application/geo+json).';

  return tool({
    description: `Display rich data using JupyterLab's MIME renderers. You can provide either: (1) a single payload with "mime_type" + "data", or (2) a full Jupyter MIME bundle in "data" (mapping MIME types to values). Supports standard types like application/json, text/html, text/latex, image/png, and custom application/vnd.* types. ${mimeTypesList}`,
    inputSchema: z.union([
      z.object({
        mime_type: z
          .string()
          .describe(
            'The MIME type of the data (e.g., "application/json", "text/html", "text/latex", "image/png")'
          ),
        data: z
          .any()
          .describe(
            'The content to display for this MIME type. For binary formats like images, use base64 encoding.'
          ),
        metadata: z
          .record(z.string(), z.any())
          .optional()
          .nullable()
          .describe('Optional metadata for the MIME bundle')
      }),
      z.object({
        data: z
          .record(z.string(), z.any())
          .describe(
            'A full Jupyter MIME bundle mapping MIME types to values (e.g., {"text/latex":"\\\\boxed{5}","text/plain":"5"}).'
          ),
        metadata: z
          .record(z.string(), z.any())
          .optional()
          .nullable()
          .describe('Optional metadata for the MIME bundle')
      })
    ]),
    execute: async (input: {
      mime_type?: string;
      data: unknown;
      metadata?: Record<string, any> | null;
    }) => {
      // The tool returns the data in a structured format.
      // The AIKernel will intercept this and emit a proper display_data message.
      return {
        displayed: true,
        ...(input.mime_type ? { mime_type: input.mime_type } : {}),
        data: input.data,
        metadata: input.metadata
      };
    }
  });
}
