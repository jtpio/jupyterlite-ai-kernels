# jupyterlite-ai-kernels

[![Github Actions Status](https://github.com/jtpio/jupyterlite-ai-kernels/workflows/Build/badge.svg)](https://github.com/jtpio/jupyterlite-ai-kernels/actions/workflows/build.yml)

AI kernels for JupyterLite. This extension dynamically registers one kernel per configured AI provider from `@jupyterlite/ai`. When users open a notebook with one of these kernels, cell contents are sent as prompts to the AI model and responses are streamed back.

https://github.com/user-attachments/assets/ee5bc8b1-c0bd-4603-b2f4-a98db350d217


## Requirements

- JupyterLite >= 0.6.0
- `@jupyterlite/ai` >= 0.10.0

## Install

To install the extension, execute:

```bash
pip install jupyterlite-ai-kernels
```

Then build your JupyterLite site:

```bash
jupyter lite build
```

## Uninstall

To remove the extension, execute:

```bash
pip uninstall jupyterlite-ai-kernels
```

## Contributing

### Development install

Note: You will need NodeJS to build the extension package.

This project uses [pnpm](https://pnpm.io/) as the package manager.

```bash
# Clone the repo to your local environment
# Change directory to the jupyterlite-ai-kernels directory
# Install package in development mode
python -m pip install -e .

# Link your development version of the extension with JupyterLab
jupyter labextension develop . --overwrite

# Rebuild extension Typescript source after making changes
pnpm run build
```

You can watch the source directory and run JupyterLab at the same time in different terminals to watch for changes in the extension's source and automatically rebuild the extension.

```bash
# Watch the source directory in one terminal, automatically rebuilding when needed
pnpm run watch
# Run JupyterLab in another terminal
jupyter lab
```

With the watch command running, every saved change will immediately be built locally and available in your running JupyterLab. Refresh JupyterLab to load the change in your browser (you may need to wait several seconds for the extension to be rebuilt).

### Development uninstall

```bash
pip uninstall jupyterlite-ai-kernels
```

In development mode, you will also need to remove the symlink created by `jupyter labextension develop`
command. To find its location, you can run `jupyter labextension list` to figure out where the `labextensions`
folder is located. Then you can remove the symlink named `@jupyterlite/ai-kernels` within that folder.

### Packaging the extension

See [RELEASE](RELEASE.md)
