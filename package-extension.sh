#!/bin/bash
# Script to install dependencies, compile TypeScript, and package VS Code extension

set -e

echo "Installing dependencies..."
npm install

echo "Compiling TypeScript code..."
npm run compile

echo "Packaging extension..."
vsce package

echo "Done! VSIX file created."
