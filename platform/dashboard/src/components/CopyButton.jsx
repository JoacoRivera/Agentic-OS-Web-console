import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';

function CopyButton({ label, value }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard denied — button simply doesn't flash */
    }
  };

  return (
    <button className={`copy-btn${copied ? ' copied' : ''}`} onClick={copy} title={value}>
      {copied ? <Check size={10} /> : <Copy size={10} />}
      <span>{copied ? 'copied' : label}</span>
    </button>
  );
}

/**
 * Copy cluster for a doc/workflow/skill page: relative path, absolute path,
 * and an editor open command. No file:// links — unreliable across
 * browsers/WSL (plan: Copy actions).
 */
export default function CopyButtons({ relPath, absPath }) {
  return (
    <div className="copy-cluster">
      <CopyButton label="rel path" value={relPath} />
      <CopyButton label="abs path" value={absPath} />
      <CopyButton label="open cmd" value={`code "${absPath}"`} />
    </div>
  );
}
