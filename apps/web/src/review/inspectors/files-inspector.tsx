import {IconFile} from "@tabler/icons-react";

import type {ArtifactVersion} from "@/api/client";
import {formatBytes} from "@/lib/presentation";
import {InspectorSection} from "./inspector-layout.tsx";

export function FilesInspector({
  onSelect,
  selectedPath,
  version,
}: {
  readonly onSelect: (path: string) => void;
  readonly selectedPath: string;
  readonly version: ArtifactVersion;
}) {
  return (
    <div className="as-inspector-stack">
      <InspectorSection count={version.manifest.entries.length} title="Manifest">
        <ol className="as-file-list">
          {version.manifest.entries.map((entry) => (
            <li key={entry.path}>
              <button
                aria-current={selectedPath === entry.path ? "true" : undefined}
                data-selected={selectedPath === entry.path}
                onClick={() => onSelect(entry.path)}
                type="button"
              >
                <span className="as-file-list__icon"><IconFile stroke={1.8} /></span>
                <span className="as-file-list__identity">
                  <code>{entry.path}</code>
                  <small>{entry.mediaType}</small>
                </span>
                <span className="as-file-list__size">{formatBytes(entry.size)}</span>
              </button>
            </li>
          ))}
        </ol>
      </InspectorSection>
    </div>
  );
}

