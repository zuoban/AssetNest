import type { FolderRecord } from "../../shared/types";

export interface FolderTreeNode {
  folder: FolderRecord;
  children: FolderTreeNode[];
  depth: number;
  directAssetCount: number;
  totalAssetCount: number;
  descendantFolderCount: number;
  pathNames: string[];
  pathLabel: string;
  ancestorIds: string[];
}

export interface FolderTreeData {
  roots: FolderTreeNode[];
  nodeMap: Map<string, FolderTreeNode>;
  flatNodes: FolderTreeNode[];
}

function compareFolders(a: FolderRecord, b: FolderRecord): number {
  if (a.position !== b.position) {
    return a.position - b.position;
  }
  return a.name.localeCompare(b.name, "zh-CN", { numeric: true, sensitivity: "base" });
}

/**
 * Builds a deterministic multi-level folder tree from flat FolderRecord items.
 * Safely handles orphaned parentIds (promoted to root) and guards against cycles.
 */
export function buildFolderTree(folders: FolderRecord[]): FolderTreeData {
  const byId = new Map<string, FolderRecord>();
  for (const folder of folders) {
    byId.set(folder.id, folder);
  }

  const childrenByParent = new Map<string | null, FolderRecord[]>();
  const rootFolders: FolderRecord[] = [];

  // Detect any cycle or missing parent and treat broken references as roots
  const hasCycleToSelf = (startId: string): boolean => {
    const seen = new Set<string>([startId]);
    let cursor = byId.get(startId)?.parentId ?? null;
    while (cursor) {
      if (seen.has(cursor)) return true;
      seen.add(cursor);
      cursor = byId.get(cursor)?.parentId ?? null;
    }
    return false;
  };

  for (const folder of folders) {
    const parentExists = folder.parentId !== null && byId.has(folder.parentId);
    const effectiveParentId =
      parentExists && !hasCycleToSelf(folder.id) ? folder.parentId : null;

    if (effectiveParentId === null) {
      rootFolders.push(folder);
    } else {
      const list = childrenByParent.get(effectiveParentId) ?? [];
      list.push(folder);
      childrenByParent.set(effectiveParentId, list);
    }
  }

  rootFolders.sort(compareFolders);
  for (const list of childrenByParent.values()) {
    list.sort(compareFolders);
  }

  const nodeMap = new Map<string, FolderTreeNode>();
  const flatNodes: FolderTreeNode[] = [];

  const buildNode = (
    folder: FolderRecord,
    depth: number,
    parentPathNames: string[],
    parentAncestorIds: string[],
    visiting: Set<string>
  ): FolderTreeNode => {
    visiting.add(folder.id);
    const pathNames = [...parentPathNames, folder.name];
    const ancestorIds = [...parentAncestorIds];
    const node: FolderTreeNode = {
      folder,
      children: [],
      depth,
      directAssetCount: folder.assetCount,
      totalAssetCount: folder.assetCount,
      descendantFolderCount: 0,
      pathNames,
      pathLabel: pathNames.join(" / "),
      ancestorIds
    };

    nodeMap.set(folder.id, node);
    flatNodes.push(node);

    const rawChildren = childrenByParent.get(folder.id) ?? [];
    let totalAssets = folder.assetCount;
    let descendantFolders = 0;

    for (const child of rawChildren) {
      if (visiting.has(child.id)) continue;
      const childNode = buildNode(
        child,
        depth + 1,
        pathNames,
        [...ancestorIds, folder.id],
        visiting
      );
      node.children.push(childNode);
      totalAssets += childNode.totalAssetCount;
      descendantFolders += 1 + childNode.descendantFolderCount;
    }

    node.totalAssetCount = totalAssets;
    node.descendantFolderCount = descendantFolders;
    visiting.delete(folder.id);
    return node;
  };

  const roots = rootFolders.map((folder) =>
    buildNode(folder, 0, [], [], new Set<string>())
  );

  return { roots, nodeMap, flatNodes };
}

/**
 * Returns a Set containing folderId and all of its descendant folder IDs.
 */
export function getFolderSubtreeIdSet(
  nodeMap: Map<string, FolderTreeNode>,
  folderId: string
): Set<string> {
  const result = new Set<string>();
  const start = nodeMap.get(folderId);
  if (!start) return result;

  const stack: FolderTreeNode[] = [start];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (result.has(current.folder.id)) continue;
    result.add(current.folder.id);
    for (const child of current.children) {
      stack.push(child);
    }
  }
  return result;
}

/**
 * Returns the breadcrumb chain from root down to folderId (inclusive).
 */
export function getFolderBreadcrumb(
  nodeMap: Map<string, FolderTreeNode>,
  folderId: string
): FolderTreeNode[] {
  const target = nodeMap.get(folderId);
  if (!target) return [];
  const chain: FolderTreeNode[] = [];
  for (const id of target.ancestorIds) {
    const ancestor = nodeMap.get(id);
    if (ancestor) chain.push(ancestor);
  }
  chain.push(target);
  return chain;
}

/**
 * Formats a folder node for native <select> dropdowns with clear visual hierarchy.
 */
export function formatFolderSelectOption(node: FolderTreeNode): string {
  if (node.depth === 0) return node.folder.name;
  const indent = "\u00A0\u00A0".repeat(node.depth);
  return `${indent}└ ${node.folder.name}`;
}

/**
 * Collects IDs of all folders that have at least one child folder.
 */
export function collectExpandableFolderIds(roots: FolderTreeNode[]): string[] {
  const ids: string[] = [];
  const walk = (nodes: FolderTreeNode[]) => {
    for (const node of nodes) {
      if (node.children.length > 0) {
        ids.push(node.folder.id);
        walk(node.children);
      }
    }
  };
  walk(roots);
  return ids;
}
