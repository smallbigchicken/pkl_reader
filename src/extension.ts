import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { spawn } from "child_process";

type PklNodeKind = "value" | "error" | "truncated" | "ref";

interface PklNode {
  kind: PklNodeKind;
  type: string;
  label: string;
  path: string;
  children: PklNode[];
  meta?: Record<string, unknown>;
}

type ParseResult = { ok: true; root: PklNode } | { ok: false; root: PklNode; raw: string; stderr: string };

function isPklUri(uri: vscode.Uri | undefined): uri is vscode.Uri {
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

function statMtimeMs(filePath: string): number | undefined {
  try {
    const s = fs.statSync(filePath);
    return s.mtimeMs;
  } catch {
    return undefined;
  }
}

function parsePickle(context: vscode.ExtensionContext, filePath: string): Promise<ParseResult> {
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
      const root: PklNode = {
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
        const root = JSON.parse(raw) as PklNode;
        resolve({ ok: true, root });
      } catch (e) {
        const root: PklNode = {
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

class PickleTreeProvider implements vscode.TreeDataProvider<PklNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<PklNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _context: vscode.ExtensionContext;
  private _output: vscode.OutputChannel;

  private _targetUri: vscode.Uri | undefined;
  private _cache = new Map<string, { mtimeMs: number; root: PklNode }>();
  private _root: PklNode | undefined;

  constructor(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
    this._context = context;
    this._output = output;
  }

  getTargetUri() {
    return this._targetUri;
  }

  async setTargetUri(uri: vscode.Uri | undefined) {
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

  getTreeItem(element: PklNode): vscode.TreeItem {
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

  getChildren(element?: PklNode): Thenable<PklNode[]> {
    if (!this._root) return Promise.resolve([]);
    if (!element) return Promise.resolve([this._root]);
    return Promise.resolve(element.children ?? []);
  }
}

function getNonce() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  return nonce;
}

class PicklePreviewEditorProvider implements vscode.CustomReadonlyEditorProvider {
  private _context: vscode.ExtensionContext;
  private _treeProvider: PickleTreeProvider;
  private _panels = new Map<string, vscode.WebviewPanel>();

  constructor(context: vscode.ExtensionContext, treeProvider: PickleTreeProvider) {
    this._context = context;
    this._treeProvider = treeProvider;
  }

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._context.extensionUri, "media"),
        vscode.Uri.joinPath(this._context.extensionUri, "python"),
      ],
    };

    const nonce = getNonce();
    const scriptUri = webviewPanel.webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, "media", "viewer.js"));
    const styleUri = webviewPanel.webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, "media", "viewer.css"));
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

  private async _sendData(uri: vscode.Uri) {
    const panel = this._panels.get(uri.toString());
    if (!panel) return;

    if (!isPklUri(uri)) {
      panel.webview.postMessage({
        type: "setData",
        data: {
          kind: "error",
          type: "not_pkl",
          label: "Not a .pkl file",
          path: "$",
          children: [],
        } satisfies PklNode,
      });
      return;
    }

    const r = await parsePickle(this._context, uri.fsPath);
    panel.webview.postMessage({ type: "setData", data: r.root });
    await this._treeProvider.setTargetUri(uri);
  }
}

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("PKL Preview");
  const treeProvider = new PickleTreeProvider(context, output);
  const editorProvider = new PicklePreviewEditorProvider(context, treeProvider);

  context.subscriptions.push(output);

  context.subscriptions.push(vscode.window.registerTreeDataProvider("pklPreview.tree", treeProvider));
  context.subscriptions.push(vscode.window.registerCustomEditorProvider("pklPreview.viewer", editorProvider));

  context.subscriptions.push(
    vscode.commands.registerCommand("pklPreview.openWithPreview", async (uri?: vscode.Uri) => {
      const targetUri =
        uri ??
        vscode.window.activeTextEditor?.document?.uri ??
        vscode.window.activeNotebookEditor?.notebook?.uri;

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
      const targetUri = treeProvider.getTargetUri() ?? vscode.window.activeTextEditor?.document?.uri;
      if (targetUri) await treeProvider.setTargetUri(targetUri);
      await editorProvider.refreshActivePanels();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pklPreview.copyJsonPath", async (node?: PklNode) => {
      if (!node?.path) return;
      await vscode.env.clipboard.writeText(node.path);
      vscode.window.setStatusBarMessage("PKL path copied", 1500);
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      const uri = editor?.document?.uri;
      if (isPklUri(uri)) await treeProvider.setTargetUri(uri);
    })
  );

  const initial = vscode.window.activeTextEditor?.document?.uri;
  if (isPklUri(initial)) {
    void treeProvider.setTargetUri(initial);
  }
}

export function deactivate() {}

