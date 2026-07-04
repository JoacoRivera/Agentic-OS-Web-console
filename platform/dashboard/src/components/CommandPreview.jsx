import { CopyButton } from './CopyButton.jsx';

/**
 * Command preview: the exact text a human would run/type, with a copy
 * button — and deliberately nothing else. Run buttons exist only on
 * executable-allowlist cards, behind dry-run + confirm (ADR-0001).
 */
export default function CommandPreview({ command }) {
  return (
    <div className="cmd-preview">
      <code className="cmd-preview-text">{command}</code>
      <CopyButton label="copy" value={command} />
    </div>
  );
}
