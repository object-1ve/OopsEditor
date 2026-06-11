import { generateManifest } from "material-icon-theme";
import { detectLanguage } from "../types";

const manifest = generateManifest({
  folders: {
    theme: "specific",
    associations: {},
  },
  files: {
    associations: {},
  },
  languages: {
    associations: {},
  },
});

const iconModules = import.meta.glob("../../node_modules/material-icon-theme/icons/*.svg", {
  eager: true,
  import: "default",
}) as Record<string, string>;

const iconUrlMap = Object.fromEntries(
  Object.entries(iconModules).map(([modulePath, url]) => [
    modulePath.split("/").pop() ?? modulePath,
    url,
  ]),
);

interface MaterialFileIconProps {
  name: string;
  path?: string;
  isDirectory?: boolean;
  isOpen?: boolean;
  isRoot?: boolean;
  size?: number;
  className?: string;
}

function getIconUrlByName(iconName?: string) {
  if (!iconName) return undefined;

  const iconPath = manifest.iconDefinitions?.[iconName]?.iconPath;
  if (!iconPath) return undefined;

  const fileName = iconPath.split("/").pop();
  if (!fileName) return undefined;

  return iconUrlMap[fileName];
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
  if (directNameMatch) {
    return directNameMatch;
  }

  for (const extension of getExtensionCandidates(normalizedName)) {
    const extensionMatch = manifest.fileExtensions?.[extension];
    if (extensionMatch) {
      return extensionMatch;
    }
  }

  const { language: languageId } = detectLanguage(fileName);
  const languageMatch = manifest.languageIds?.[languageId];
  if (languageMatch) {
    return languageMatch;
  }

  return manifest.file;
}

function resolveFolderIconName(folderName: string, isOpen: boolean, isRoot: boolean) {
  const normalizedName = folderName.toLowerCase();

  if (isRoot) {
    const rootNamedIcon = isOpen
      ? manifest.rootFolderNamesExpanded?.[normalizedName] ?? manifest.rootFolderNames?.[normalizedName]
      : manifest.rootFolderNames?.[normalizedName] ?? manifest.rootFolderNamesExpanded?.[normalizedName];

    if (rootNamedIcon) {
      return rootNamedIcon;
    }

    return isOpen ? manifest.rootFolderExpanded ?? manifest.rootFolder : manifest.rootFolder ?? manifest.rootFolderExpanded;
  }

  const folderNamedIcon = isOpen
    ? manifest.folderNamesExpanded?.[normalizedName] ?? manifest.folderNames?.[normalizedName]
    : manifest.folderNames?.[normalizedName] ?? manifest.folderNamesExpanded?.[normalizedName];

  if (folderNamedIcon) {
    return folderNamedIcon;
  }

  return isOpen ? manifest.folderExpanded ?? manifest.folder : manifest.folder ?? manifest.folderExpanded;
}

export default function MaterialFileIcon({
  name,
  isDirectory = false,
  isOpen = false,
  isRoot = false,
  size = 14,
  className = "",
}: MaterialFileIconProps) {
  const iconName = isDirectory
    ? resolveFolderIconName(name, isOpen, isRoot)
    : resolveFileIconName(name);

  const iconUrl = getIconUrlByName(iconName);
  if (!iconUrl) {
    return null;
  }

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
