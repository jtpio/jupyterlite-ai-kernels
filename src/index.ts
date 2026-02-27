// Copyright (c) JupyterLite Contributors
// Distributed under the terms of the Modified BSD License.

import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { IRenderMimeRegistry } from '@jupyterlab/rendermime';

import { IKernelSpecs } from '@jupyterlite/services';

import {
  IAISettingsModel,
  IAgentManagerFactory,
  IProviderRegistry,
  IToolRegistry
} from '@jupyterlite/ai';

// Import types from internal paths since @jupyterlite/ai doesn't export them publicly
// TODO: Upstream should export these types from the main entry point
import type { AISettingsModel } from '@jupyterlite/ai/lib/models/settings-model';
import type { AgentManagerFactory } from '@jupyterlite/ai/lib/agent';

import { AIKernelManager } from './kernel-manager';

/**
 * A plugin to register AI kernels dynamically based on configured providers.
 */
const aiKernelsPlugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlite-ai-kernels:plugin',
  autoStart: true,
  // Cast tokens to work around portal-based type mismatches with @lumino/coreutils
  requires: [IKernelSpecs, IAISettingsModel, IAgentManagerFactory] as any,
  optional: [IProviderRegistry, IToolRegistry, IRenderMimeRegistry] as any,
  activate: (
    app: JupyterFrontEnd,
    kernelSpecs: IKernelSpecs,
    settingsModel: AISettingsModel,
    agentManagerFactory: AgentManagerFactory,
    providerRegistry?: IProviderRegistry,
    toolRegistry?: IToolRegistry,
    renderMimeRegistry?: IRenderMimeRegistry
  ) => {
    const manager = new AIKernelManager({
      kernelSpecs,
      settingsModel,
      agentManagerFactory,
      providerRegistry,
      toolRegistry,
      renderMimeRegistry
    });
    console.log('AI Kernels extension activated', manager);
  }
};

const plugins: JupyterFrontEndPlugin<any>[] = [aiKernelsPlugin];

export default plugins;
