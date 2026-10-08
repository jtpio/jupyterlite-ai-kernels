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
} from '@jupyternaut/agent';

// Kernel specs must be registered at activation for the launcher to list them.
// eslint-disable-next-line jupyter/prefer-lazy-imports
import { AIKernelManager } from './kernel-manager';

/**
 * A plugin to register AI kernels dynamically based on configured providers.
 */
const aiKernelsPlugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlite-ai-kernels:plugin',
  description: 'Registers one AI kernel per configured AI provider.',
  autoStart: true,
  requires: [IKernelSpecs, IAISettingsModel, IAgentManagerFactory],
  optional: [IProviderRegistry, IToolRegistry, IRenderMimeRegistry],
  activate: (
    app: JupyterFrontEnd,
    kernelSpecs: IKernelSpecs,
    settingsModel: IAISettingsModel,
    agentManagerFactory: IAgentManagerFactory,
    providerRegistry: IProviderRegistry | null,
    toolRegistry: IToolRegistry | null,
    renderMimeRegistry: IRenderMimeRegistry | null
  ) => {
    new AIKernelManager({
      kernelSpecs,
      settingsModel,
      agentManagerFactory,
      providerRegistry: providerRegistry ?? undefined,
      toolRegistry: toolRegistry ?? undefined,
      renderMimeRegistry: renderMimeRegistry ?? undefined
    });
  }
};

export default [aiKernelsPlugin];
