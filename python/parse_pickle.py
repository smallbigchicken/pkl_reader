import argparse
import json
import os
import pickle
import traceback


def _safe_repr(value, max_len):
    try:
        s = repr(value)
    except Exception:
        s = "<unrepr-able>"
    if len(s) > max_len:
        return s[: max_len - 1] + "…"
    return s


def _type_name(value):
    try:
        t = type(value)
        if t.__module__ == "builtins":
            return t.__name__
        return f"{t.__module__}.{t.__name__}"
    except Exception:
        return "<unknown-type>"


class _Converter:
    def __init__(self, max_depth, max_children, max_str_len, bytes_preview_len):
        self.max_depth = max_depth
        self.max_children = max_children
        self.max_str_len = max_str_len
        self.bytes_preview_len = bytes_preview_len
        self._memo = {}
        self._next_ref = 1

    def _make_ref(self, obj_id):
        return {
            "kind": "ref",
            "type": "ref",
            "label": f"<ref #{self._memo[obj_id]}>",
            "path": "",
            "children": [],
            "meta": {"refId": self._memo[obj_id]},
        }

    def _alloc_ref(self, obj_id):
        self._memo[obj_id] = self._next_ref
        self._next_ref += 1
        return self._memo[obj_id]

    def to_node(self, value, path="$", depth=0, prefix_label=None):
        if depth > self.max_depth:
            return {
                "kind": "truncated",
                "type": _type_name(value),
                "label": (prefix_label + " " if prefix_label else "") + "<max depth reached>",
                "path": path,
                "children": [],
                "meta": {"maxDepth": self.max_depth},
            }

        obj_id = id(value)
        is_container = isinstance(value, (dict, list, tuple, set))
        if is_container:
            if obj_id in self._memo:
                node = self._make_ref(obj_id)
                node["path"] = path
                if prefix_label:
                    node["label"] = f"{prefix_label} {node['label']}"
                return node
            ref_id = self._alloc_ref(obj_id)
        else:
            ref_id = None

        tname = _type_name(value)

        if isinstance(value, dict):
            label = f"dict ({len(value)})"
            children = []
            items = list(value.items())
            over = max(0, len(items) - self.max_children)
            items = items[: self.max_children]
            for k, v in items:
                k_repr = _safe_repr(k, self.max_str_len)
                child_path = f"{path}[{k_repr}]"
                child_node = self.to_node(v, path=child_path, depth=depth + 1)
                child_node["label"] = f"{k_repr}: {child_node['label']}"
                children.append(child_node)
            if over:
                children.append(
                    {
                        "kind": "truncated",
                        "type": "truncated",
                        "label": f"<{over} more item(s) omitted>",
                        "path": path,
                        "children": [],
                        "meta": {"omitted": over},
                    }
                )
            node = {
                "kind": "value",
                "type": tname,
                "label": label,
                "path": path,
                "children": children,
                "meta": {"refId": ref_id},
            }
        elif isinstance(value, list):
            label = f"list ({len(value)})"
            children = []
            over = max(0, len(value) - self.max_children)
            for i, v in enumerate(value[: self.max_children]):
                child_path = f"{path}[{i}]"
                child_node = self.to_node(v, path=child_path, depth=depth + 1)
                child_node["label"] = f"[{i}] {child_node['label']}"
                children.append(child_node)
            if over:
                children.append(
                    {
                        "kind": "truncated",
                        "type": "truncated",
                        "label": f"<{over} more item(s) omitted>",
                        "path": path,
                        "children": [],
                        "meta": {"omitted": over},
                    }
                )
            node = {
                "kind": "value",
                "type": tname,
                "label": label,
                "path": path,
                "children": children,
                "meta": {"refId": ref_id},
            }
        elif isinstance(value, tuple):
            label = f"tuple ({len(value)})"
            children = []
            over = max(0, len(value) - self.max_children)
            for i, v in enumerate(value[: self.max_children]):
                child_path = f"{path}[{i}]"
                child_node = self.to_node(v, path=child_path, depth=depth + 1)
                child_node["label"] = f"[{i}] {child_node['label']}"
                children.append(child_node)
            if over:
                children.append(
                    {
                        "kind": "truncated",
                        "type": "truncated",
                        "label": f"<{over} more item(s) omitted>",
                        "path": path,
                        "children": [],
                        "meta": {"omitted": over},
                    }
                )
            node = {
                "kind": "value",
                "type": tname,
                "label": label,
                "path": path,
                "children": children,
                "meta": {"refId": ref_id},
            }
        elif isinstance(value, set):
            label = f"set ({len(value)})"
            children = []
            values = sorted(list(value), key=lambda x: _safe_repr(x, self.max_str_len))
            over = max(0, len(values) - self.max_children)
            for i, v in enumerate(values[: self.max_children]):
                child_path = f"{path}[{i}]"
                child_node = self.to_node(v, path=child_path, depth=depth + 1)
                child_node["label"] = f"[{i}] {child_node['label']}"
                children.append(child_node)
            if over:
                children.append(
                    {
                        "kind": "truncated",
                        "type": "truncated",
                        "label": f"<{over} more item(s) omitted>",
                        "path": path,
                        "children": [],
                        "meta": {"omitted": over},
                    }
                )
            node = {
                "kind": "value",
                "type": tname,
                "label": label,
                "path": path,
                "children": children,
                "meta": {"refId": ref_id},
            }
        elif isinstance(value, (bytes, bytearray)):
            b = bytes(value)
            preview = b[: self.bytes_preview_len].hex()
            suffix = "" if len(b) <= self.bytes_preview_len else "…"
            node = {
                "kind": "value",
                "type": tname,
                "label": f"bytes ({len(b)}) 0x{preview}{suffix}",
                "path": path,
                "children": [],
                "meta": {"length": len(b)},
            }
        elif isinstance(value, str):
            s = value
            if len(s) > self.max_str_len:
                s = s[: max(0, self.max_str_len - 1)] + "…"
            node = {
                "kind": "value",
                "type": tname,
                "label": _safe_repr(s, self.max_str_len),
                "path": path,
                "children": [],
                "meta": {"length": len(value)},
            }
        else:
            node = {
                "kind": "value",
                "type": tname,
                "label": _safe_repr(value, self.max_str_len),
                "path": path,
                "children": [],
                "meta": {},
            }

        if prefix_label:
            node["label"] = f"{prefix_label} {node['label']}"

        return node


def _error_payload(exc):
    return {
        "kind": "error",
        "type": f"{exc.__class__.__module__}.{exc.__class__.__name__}",
        "label": str(exc) or repr(exc),
        "path": "$",
        "children": [],
        "meta": {"traceback": traceback.format_exc()},
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("file", help="pickle file path")
    parser.add_argument("--max-depth", type=int, default=8)
    parser.add_argument("--max-children", type=int, default=200)
    parser.add_argument("--max-str-len", type=int, default=2000)
    parser.add_argument("--bytes-preview-len", type=int, default=64)
    args = parser.parse_args()

    try:
        with open(args.file, "rb") as f:
            obj = pickle.load(f)
        converter = _Converter(
            max_depth=args.max_depth,
            max_children=args.max_children,
            max_str_len=args.max_str_len,
            bytes_preview_len=args.bytes_preview_len,
        )
        base = os.path.basename(args.file)
        root = converter.to_node(obj, path="$", depth=0, prefix_label=base)
        print(json.dumps(root, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps(_error_payload(exc), ensure_ascii=False))


if __name__ == "__main__":
    main()

