"use strict";

const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

function isPklUri(uri) {
  if (!uri) return false;
  return uri.fsPath.toLowerCase().endsWith(".pkl");
}

function getConfig() {
  const c = vscode.workspace.getConfiguration("pklPreview");
  return {
    pythonPath: String(c.get("pythonPath", "python")),
    maxDepth: Number(c.get("maxDepth", 8)),
    maxChildrenPerNode: Number(c.get("maxChildrenPerNode", 200)),
    maxStringLength: Number(c.get("maxStringLength", 2000)),
    bytesPreviewLength: Number(c.get("bytesPreviewLength", 64)),
  };
}

function statMtimeMs(filePath) {
  try {
    const s = fs.statSync(filePath);
    return s.mtimeMs;
  } catch {
    return undefined;
  }
}

function parsePickle(context, filePath) {
  const cfg = getConfig();
  const scriptPath = path.join(context.extensionPath, "python", "parse_pickle.py");

  return new Promise((resolve) => {
    const args = [
      "-u",
      scriptPath,
      filePath,
      "--max-depth",
      String(cfg.maxDepth),
      "--max-children",
      String(cfg.maxChildrenPerNode),
      "--max-str-len",
      String(cfg.maxStringLength),
      "--bytes-preview-len",
      String(cfg.bytesPreviewLength),
    ];

    const child = spawn(cfg.pythonPath, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });

    child.on("error", (err) => {
      const root = {
        kind: "error",
        type: "spawn_error",
        label: `Failed to start python: ${String(err)}`,
        path: "$",
        children: [],
        meta: {},
      };
      resolve({ ok: false, root, raw: "", stderr: String(err) });
    });

    child.on("close", () => {
      const raw = stdout.trim();
      try {
        const root = JSON.parse(raw);
        resolve({ ok: true, root });
      } catch (e) {
        const root = {
          kind: "error",
          type: "parse_error",
          label: `Failed to parse parser output: ${String(e)}`,
          path: "$",
          children: [],
          meta: { raw },
        };
        resolve({ ok: false, root, raw, stderr });
      }
    });
  });
}

class PickleTreeProvider {
  constructor(context, output) {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this._context = context;
    this._output = output;
    this._targetUri = undefined;
    this._cache = new Map();
    this._root = undefined;
  }

  getTargetUri() {
    return this._targetUri;
  }

  async setTargetUri(uri) {
    this._targetUri = uri;
    await this.refresh();
  }

  async refresh() {
    const uri = this._targetUri;
    if (!isPklUri(uri)) {
      this._root = {
        kind: "value",
        type: "info",
        label: "请选择一个 .pkl 文件",
        path: "$",
        children: [],
        meta: {},
      };
      this._onDidChangeTreeData.fire(undefined);
      return;
    }

    const filePath = uri.fsPath;
    const mtimeMs = statMtimeMs(filePath);
    if (mtimeMs === undefined) {
      this._root = {
        kind: "error",
        type: "fs_error",
        label: "无法读取文件（不存在或无权限）",
        path: "$",
        children: [],
        meta: { filePath },
      };
      this._onDidChangeTreeData.fire(undefined);
      return;
    }

    const cached = this._cache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs) {
      this._root = cached.root;
      this._onDidChangeTreeData.fire(undefined);
      return;
    }

    this._root = {
      kind: "value",
      type: "loading",
      label: "Loading…",
      path: "$",
      children: [],
      meta: {},
    };
    this._onDidChangeTreeData.fire(undefined);

    const startedAt = Date.now();
    const r = await parsePickle(this._context, filePath);
    const cost = Date.now() - startedAt;

    if (r.ok) {
      this._root = r.root;
      this._cache.set(filePath, { mtimeMs, root: r.root });
      this._output.appendLine(`[pkl] parsed ${filePath} in ${cost}ms`);
    } else {
      this._root = r.root;
      this._output.appendLine(`[pkl] parse failed ${filePath} in ${cost}ms`);
      if (r.stderr) this._output.appendLine(r.stderr);
      if (r.raw) this._output.appendLine(r.raw);
    }

    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element) {
    const collapsible =
      element.children && element.children.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;

    const item = new vscode.TreeItem(element.label, collapsible);
    item.description = element.type;
    item.tooltip = `${element.path}\n${element.type}`;
    item.contextValue = "pklNode";
    return item;
  }

  getChildren(element) {
    if (!this._root) return Promise.resolve([]);
    if (!element) return Promise.resolve([this._root]);
    return Promise.resolve(element.children || []);
  }
}

function getNonce() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  return nonce;
}

class PicklePreviewEditorProvider {
  constructor(context, treeProvider) {
    this._context = context;
    this._treeProvider = treeProvider;
    this._panels = new Map();
  }

  openCustomDocument(uri) {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(document, webviewPanel) {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._context.extensionUri, "media"),
        vscode.Uri.joinPath(this._context.extensionUri, "python"),
      ],
    };

    const nonce = getNonce();
    const scriptUri = webviewPanel.webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, "media", "viewer.js")
    );
    const styleUri = webviewPanel.webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, "media", "viewer.css")
    );

    webviewPanel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webviewPanel.webview.cspSource}; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}">
  <title>PKL Preview</title>
</head>
<body>
  <div class="toolbar">
    <input id="search" placeholder="Search label/path" />
    <button id="refresh">Refresh</button>
  </div>
  <div id="root" class="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;

    const key = document.uri.toString();
    this._panels.set(key, webviewPanel);
    webviewPanel.onDidDispose(() => this._panels.delete(key));

    webviewPanel.webview.onDidReceiveMessage(async (msg) => {
      if (!msg || typeof msg.type !== "string") return;
      if (msg.type === "ready" || msg.type === "refresh") {
        await this._sendData(document.uri);
      }
      if (msg.type === "copyPath" && typeof msg.path === "string") {
        await vscode.env.clipboard.writeText(msg.path);
        vscode.window.setStatusBarMessage("PKL path copied", 1500);
      }
    });

    await this._sendData(document.uri);
  }

  async refreshActivePanels() {
    for (const [k, panel] of this._panels.entries()) {
      if (panel.visible) {
        const uri = vscode.Uri.parse(k);
        await this._sendData(uri);
      }
    }
  }

  async _sendData(uri) {
    const panel = this._panels.get(uri.toString());
    if (!panel) return;

    if (!isPklUri(uri)) {
      panel.webview.postMessage({
        type: "setData",
        data: { kind: "error", type: "not_pkl", label: "Not a .pkl file", path: "$", children: [] },
      });
      return;
    }

    const r = await parsePickle(this._context, uri.fsPath);
    panel.webview.postMessage({ type: "setData", data: r.root });
    await this._treeProvider.setTargetUri(uri);
  }
}

function activate(context) {
  const output = vscode.window.createOutputChannel("PKL Preview");
  const treeProvider = new PickleTreeProvider(context, output);
  const editorProvider = new PicklePreviewEditorProvider(context, treeProvider);

  context.subscriptions.push(output);
  context.subscriptions.push(vscode.window.registerTreeDataProvider("pklPreview.tree", treeProvider));
  context.subscriptions.push(vscode.window.registerCustomEditorProvider("pklPreview.viewer", editorProvider));

  context.subscriptions.push(
    vscode.commands.registerCommand("pklPreview.openWithPreview", async (uri) => {
      const targetUri = uri || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
      if (!isPklUri(targetUri)) {
        vscode.window.showWarningMessage("请选择一个 .pkl 文件");
        return;
      }

      await treeProvider.setTargetUri(targetUri);
      await vscode.commands.executeCommand("vscode.openWith", targetUri, "pklPreview.viewer", vscode.ViewColumn.Active);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pklPreview.refresh", async () => {
      const targetUri = treeProvider.getTargetUri() || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
      if (targetUri) await treeProvider.setTargetUri(targetUri);
      await editorProvider.refreshActivePanels();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pklPreview.copyJsonPath", async (node) => {
      if (!node || !node.path) return;
      await vscode.env.clipboard.writeText(node.path);
      vscode.window.setStatusBarMessage("PKL path copied", 1500);
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      const uri = editor && editor.document && editor.document.uri;
      if (isPklUri(uri)) await treeProvider.setTargetUri(uri);
    })
  );

  const initial = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri;
  if (isPklUri(initial)) {
    treeProvider.setTargetUri(initial);
  }
}

function deactivate() {}

module.exports = { activate, deactivate };

