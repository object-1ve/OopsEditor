import { useEffect, useRef, useState } from "react";
import { generateManifest } from "material-icon-theme";
import { detectLanguage } from "@/types";

const manifest = generateManifest({
  folders: { theme: "specific", associations: {} },
  files: { associations: {} },
  languages: { associations: {} },
});

// Icons are emitted by the Vite plugin and loaded as images on demand.
// Avoid dynamic SVG module imports: Tauri's webview rejects pnpm symlink URLs.
const iconBaseUrl = `${import.meta.env.BASE_URL}material-icon-theme-icons/`;

const resolvedCache = new Map<string, string | undefined>();

async function resolveIconUrl(iconName: string): Promise<string | undefined> {
  const cached = resolvedCache.get(iconName);
  if (cached !== undefined) return cached;

  const iconDef = manifest.iconDefinitions?.[iconName];
  if (!iconDef) { resolvedCache.set(iconName, undefined); return undefined; }

  const fileName = iconDef.iconPath.split("/").pop();
  if (!fileName) { resolvedCache.set(iconName, undefined); return undefined; }

  const url = `${iconBaseUrl}${encodeURIComponent(fileName)}`;
  resolvedCache.set(iconName, url);
  return url;
}

function useMaterialIconUrl(iconName: string | undefined): string | undefined {
  const [url, setUrl] = useState<string | undefined>(() =>
    iconName ? resolvedCache.get(iconName) : undefined,
  );
  const ignoreRef = useRef(false);

  useEffect(() => {
    if (!iconName) { setUrl(undefined); return; }
    const cached = resolvedCache.get(iconName);
    if (cached !== undefined) { setUrl(cached); return; }

    ignoreRef.current = false;
    resolveIconUrl(iconName).then((resolved) => {
      if (!ignoreRef.current) setUrl(resolved);
    });
    return () => { ignoreRef.current = true; };
  }, [iconName]);

  return url;
}

interface MaterialFileIconProps {
  name: string;
  path?: string;
  isDirectory?: boolean;
  isOpen?: boolean;
  isRoot?: boolean;
  size?: number;
  className?: string;
}

function getExtensionCandidates(fileName: string) {
  const parts = fileName.toLowerCase().split(".");
  if (parts.length <= 1) return [];
  const candidates: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    candidates.push(parts.slice(index).join("."));
  }
  return candidates;
}

function resolveFileIconName(fileName: string) {
  const normalizedName = fileName.toLowerCase();
  const directNameMatch = manifest.fileNames?.[normalizedName];
  if (directNameMatch) return directNameMatch;
  for (const extension of getExtensionCandidates(normalizedName)) {
    const extensionMatch = manifest.fileExtensions?.[extension];
    if (extensionMatch) return extensionMatch;
  }
  const { language: languageId } = detectLanguage(fileName);
  const languageMatch = manifest.languageIds?.[languageId];
  if (languageMatch) return languageMatch;
  return manifest.file;
}

function resolveFolderIconName(folderName: string, isOpen: boolean, isRoot: boolean) {
  const normalizedName = folderName.toLowerCase();
  if (isRoot) {
    const rootNamedIcon = isOpen
      ? manifest.rootFolderNamesExpanded?.[normalizedName] ?? manifest.rootFolderNames?.[normalizedName]
      : manifest.rootFolderNames?.[normalizedName] ?? manifest.rootFolderNamesExpanded?.[normalizedName];
    if (rootNamedIcon) return rootNamedIcon;
    return isOpen ? manifest.rootFolderExpanded ?? manifest.rootFolder : manifest.rootFolder ?? manifest.rootFolderExpanded;
  }
  const folderNamedIcon = isOpen
    ? manifest.folderNamesExpanded?.[normalizedName] ?? manifest.folderNames?.[normalizedName]
    : manifest.folderNames?.[normalizedName] ?? manifest.folderNamesExpanded?.[normalizedName];
  if (folderNamedIcon) return folderNamedIcon;
  return isOpen ? manifest.folderExpanded ?? manifest.folder : manifest.folder ?? manifest.folderExpanded;
}

export default function MaterialFileIcon({
  name, isDirectory = false, isOpen = false, isRoot = false, size = 14, className = "",
}: MaterialFileIconProps) {
  const iconName = isDirectory
    ? resolveFolderIconName(name, isOpen, isRoot)
    : resolveFileIconName(name);

  const iconUrl = useMaterialIconUrl(iconName);
  if (!iconUrl) return null;

  return (
    <img
      src={iconUrl}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      className={`shrink-0 select-none ${className}`.trim()}
      draggable={false}
    />
  );
}
