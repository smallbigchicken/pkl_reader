(function () {
  const vscode = acquireVsCodeApi();

  const rootEl = document.getElementById("root");
  const searchEl = document.getElementById("search");
  const refreshEl = document.getElementById("refresh");

  let currentData = null;
  let currentQuery = "";

  function text(s) {
    return document.createTextNode(String(s));
  }

  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null) continue;
        if (k === "className") n.className = String(v);
        else if (k === "onClick") n.addEventListener("click", v);
        else n.setAttribute(k, String(v));
      }
    }
    if (children) {
      for (const c of children) n.appendChild(typeof c === "string" ? text(c) : c);
    }
    return n;
  }

  function matches(node, q) {
    if (!q) return true;
    const hay = `${node.label}\n${node.type}\n${node.path}`.toLowerCase();
    return hay.includes(q);
  }

  function shouldInclude(node, q) {
    if (matches(node, q)) return true;
    if (Array.isArray(node.children)) {
      for (const c of node.children) {
        if (shouldInclude(c, q)) return true;
      }
    }
    return false;
  }

  function renderNode(node, q) {
    const hasChildren = Array.isArray(node.children) && node.children.length > 0;
    const include = shouldInclude(node, q);
    if (!include) return null;

    const copyBtn = el(
      "span",
      {
        className: "btn",
        title: "Copy path",
        onClick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          vscode.postMessage({ type: "copyPath", path: node.path });
        },
      },
      ["Copy"]
    );

    const summary = el("span", { className: "summary" }, [
      el("span", { className: node.kind === "error" ? "error" : "" }, [node.label]),
      el("span", { className: "type" }, [node.type || ""]),
      el("span", { className: "path" }, [node.path || ""]),
      copyBtn,
    ]);

    if (hasChildren) {
      const details = el("details", { className: "node" }, [
        el("summary", null, [summary]),
        el("div", null, []),
      ]);
      const container = details.lastChild;
      for (const c of node.children) {
        const childEl = renderNode(c, q);
        if (childEl) container.appendChild(childEl);
      }
      if (q && matches(node, q)) details.open = true;
      return details;
    }

    return el("div", { className: "node" }, [summary]);
  }

  function render() {
    rootEl.innerHTML = "";
    if (!currentData) {
      rootEl.appendChild(el("div", null, ["No data"]));
      return;
    }

    const n = renderNode(currentData, currentQuery);
    if (n) rootEl.appendChild(n);
    else rootEl.appendChild(el("div", null, ["No matches"]));
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "setData") {
      currentData = msg.data;
      render();
    }
  });

  searchEl.addEventListener("input", () => {
    currentQuery = String(searchEl.value || "").trim().toLowerCase();
    render();
  });

  refreshEl.addEventListener("click", () => {
    vscode.postMessage({ type: "refresh" });
  });

  vscode.postMessage({ type: "ready" });
})();

