import { useState } from 'react';
import { ChevronDown, ChevronRight, FileText, Folder } from 'lucide-react';

/**
 * Source-kind groups, in plan order. Badging by kind is the point: candid
 * raw captures must read differently from polished wiki docs (ADR-0005).
 */
const KIND_LABELS = {
  root: 'Root',
  wiki: 'Wiki',
  raw: 'Raw',
  template: 'Templates',
  skill: 'Skills',
};

function TreeNode({ node, depth, selected, onSelect }) {
  const [open, setOpen] = useState(depth < 1);
  const indent = { paddingLeft: 10 + depth * 14 };

  if (node.type === 'dir') {
    return (
      <>
        <button
          className="tree-row tree-dir"
          style={indent}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          <Folder size={11} />
          <span className="tree-name">{node.name}</span>
        </button>
        {open &&
          node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
      </>
    );
  }
  return (
    <button
      className={`tree-row tree-file${selected === node.path ? ' selected' : ''}`}
      style={indent}
      onClick={() => onSelect(node.path)}
      title={node.path}
      aria-current={selected === node.path ? 'page' : undefined}
    >
      <FileText size={11} />
      <span className="tree-name">{node.name}</span>
    </button>
  );
}

export default function DocsExplorer({ tree, selected, onSelect }) {
  const groups = Object.keys(KIND_LABELS)
    .map((kind) => ({ kind, roots: tree.roots.filter((r) => r.source === kind) }))
    .filter((g) => g.roots.length > 0);

  return (
    <div className="docs-tree">
      {groups.map(({ kind, roots }) => (
        <div key={kind} className="tree-group">
          <div className="tree-group-head">
            <span className={`badge kind-${kind}`}>{KIND_LABELS[kind]}</span>
          </div>
          {roots.map((root) =>
            root.type === 'file' ? (
              <TreeNode key={root.path} node={root} depth={0} selected={selected} onSelect={onSelect} />
            ) : (
              root.children.map((child) => (
                <TreeNode key={child.path} node={child} depth={0} selected={selected} onSelect={onSelect} />
              ))
            )
          )}
        </div>
      ))}
    </div>
  );
}
