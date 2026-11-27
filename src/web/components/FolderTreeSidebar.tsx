import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Trash2,
  X
} from "lucide-react";
import type { FolderRecord } from "../../shared/types";
import {
  collectExpandableFolderIds,
  formatFolderSelectOption,
  getFolderSubtreeIdSet,
  type FolderTreeData,
  type FolderTreeNode
} from "../utils/folderTree";

const EXPANDED_STORAGE_KEY = "assetnest.folderTree.expanded";
const FOLDER_DRAG_MIME = "application/x-assetnest-folder-id";
const ROOT_CREATE_SENTINEL = "__root__";

function loadInitialExpandedIds(): Set<string> {
  try {
    const raw = window.localStorage.getItem(EXPANDED_STORAGE_KEY);
    if (!raw) return new Set<string>();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((item): item is string => typeof item === "string"));
    }
  } catch {
    // Ignore storage read errors
  }
  return new Set<string>();
}

function saveExpandedIds(ids: Set<string>): void {
  try {
    window.localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Ignore storage write errors
  }
}

export interface FolderTreeSidebarProps {
  tree: FolderTreeData;
  selectedFolderId: string;
  onSelectFolder: (folderId: string) => void;
  onCreateFolder: (payload: {
    name: string;
    parentId: string | null;
  }) => Promise<FolderRecord | null>;
  onUpdateFolder: (
    id: string,
    payload: { name?: string; parentId?: string | null }
  ) => Promise<boolean>;
  onDeleteFolder: (node: FolderTreeNode) => void;
}

export function FolderTreeSidebar({
  tree,
  selectedFolderId,
  onSelectFolder,
  onCreateFolder,
  onUpdateFolder,
  onDeleteFolder
}: FolderTreeSidebarProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => loadInitialExpandedIds());
  const [creatingParentId, setCreatingParentId] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingBusy, setCreatingBusy] = useState(false);

  // Edit / Move modal state
  const [editingNode, setEditingNode] = useState<FolderTreeNode | null>(null);
  const [editName, setEditName] = useState("");
  const [editParentId, setEditParentId] = useState<string>("");
  const [editBusy, setEditBusy] = useState(false);

  // Drag-and-drop state
  const [draggingFolderId, setDraggingFolderId] = useState<string | null>(null);
  const [dragOverTargetId, setDragOverTargetId] = useState<string | null>(null);

  const createInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    saveExpandedIds(expandedIds);
  }, [expandedIds]);

  // Auto-expand ancestor chain whenever a nested folder is selected
  useEffect(() => {
    if (!selectedFolderId) return;
    const node = tree.nodeMap.get(selectedFolderId);
    if (!node || node.ancestorIds.length === 0) return;
    setExpandedIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of node.ancestorIds) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [selectedFolderId, tree.nodeMap]);

  useEffect(() => {
    if (creatingParentId !== null) {
      window.setTimeout(() => createInputRef.current?.focus(), 0);
    }
  }, [creatingParentId]);

  const expandableIds = useMemo(() => collectExpandableFolderIds(tree.roots), [tree.roots]);
  const allExpanded =
    expandableIds.length > 0 && expandableIds.every((id) => expandedIds.has(id));

  const toggleExpand = (folderId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  };

  const toggleExpandAll = () => {
    if (allExpanded) {
      setExpandedIds(new Set());
    } else {
      setExpandedIds(new Set(expandableIds));
    }
  };

  const startCreateFolder = (parentId: string | null) => {
    const sentinel = parentId ?? ROOT_CREATE_SENTINEL;
    if (creatingParentId === sentinel) {
      setCreatingParentId(null);
      setNewFolderName("");
      return;
    }
    if (parentId) {
      setExpandedIds((prev) => {
        if (prev.has(parentId)) return prev;
        const next = new Set(prev);
        next.add(parentId);
        return next;
      });
    }
    setCreatingParentId(sentinel);
    setNewFolderName("");
  };

  const submitCreateFolder = async () => {
    const trimmed = newFolderName.trim();
    if (!trimmed || creatingBusy || creatingParentId === null) return;
    const parentId = creatingParentId === ROOT_CREATE_SENTINEL ? null : creatingParentId;
    setCreatingBusy(true);
    try {
      const created = await onCreateFolder({ name: trimmed, parentId });
      if (created) {
        if (parentId) {
          setExpandedIds((prev) => {
            const next = new Set(prev);
            next.add(parentId);
            return next;
          });
        }
        setNewFolderName("");
        setCreatingParentId(null);
      }
    } finally {
      setCreatingBusy(false);
    }
  };

  const openEditModal = (node: FolderTreeNode) => {
    setEditingNode(node);
    setEditName(node.folder.name);
    setEditParentId(node.folder.parentId ?? "");
  };

  const blockedParentIdsForEdit = useMemo(() => {
    if (!editingNode) return new Set<string>();
    return getFolderSubtreeIdSet(tree.nodeMap, editingNode.folder.id);
  }, [editingNode, tree.nodeMap]);

  const submitEditFolder = async () => {
    if (!editingNode || editBusy) return;
    const trimmed = editName.trim();
    if (!trimmed) return;
    const nextParentId = editParentId || null;
    if (trimmed === editingNode.folder.name && nextParentId === editingNode.folder.parentId) {
      setEditingNode(null);
      return;
    }
    setEditBusy(true);
    try {
      const ok = await onUpdateFolder(editingNode.folder.id, {
        name: trimmed,
        parentId: nextParentId
      });
      if (ok) {
        if (nextParentId) {
          setExpandedIds((prev) => {
            const next = new Set(prev);
            next.add(nextParentId);
            return next;
          });
        }
        setEditingNode(null);
      }
    } finally {
      setEditBusy(false);
    }
  };

  const draggingBlockedTargets = useMemo(() => {
    if (!draggingFolderId) return new Set<string>();
    return getFolderSubtreeIdSet(tree.nodeMap, draggingFolderId);
  }, [draggingFolderId, tree.nodeMap]);

  const draggingNode = draggingFolderId ? tree.nodeMap.get(draggingFolderId) ?? null : null;

  const canDropOnFolder = (targetFolderId: string): boolean => {
    if (!draggingFolderId || !draggingNode) return false;
    if (draggingBlockedTargets.has(targetFolderId)) return false;
    if (draggingNode.folder.parentId === targetFolderId) return false;
    return true;
  };

  const handleDragStart = (event: DragEvent<HTMLDivElement>, folderId: string) => {
    event.stopPropagation();
    event.dataTransfer.setData(FOLDER_DRAG_MIME, folderId);
    event.dataTransfer.effectAllowed = "move";
    setDraggingFolderId(folderId);
  };

  const handleDragEnd = () => {
    setDraggingFolderId(null);
    setDragOverTargetId(null);
  };

  const handleDropOnFolder = async (
    event: DragEvent<HTMLDivElement>,
    targetFolderId: string | null
  ) => {
    if (!event.dataTransfer.types.includes(FOLDER_DRAG_MIME)) return;
    event.preventDefault();
    event.stopPropagation();
    const draggedId = event.dataTransfer.getData(FOLDER_DRAG_MIME) || draggingFolderId;
    setDraggingFolderId(null);
    setDragOverTargetId(null);
    if (!draggedId) return;

    const sourceNode = tree.nodeMap.get(draggedId);
    if (!sourceNode) return;
    if (sourceNode.folder.parentId === targetFolderId) return;
    if (targetFolderId !== null) {
      const blocked = getFolderSubtreeIdSet(tree.nodeMap, draggedId);
      if (blocked.has(targetFolderId)) return;
    }

    const ok = await onUpdateFolder(draggedId, { parentId: targetFolderId });
    if (ok && targetFolderId) {
      setExpandedIds((prev) => {
        const next = new Set(prev);
        next.add(targetFolderId);
        return next;
      });
    }
  };

  const renderInlineCreateInput = (placeholder: string) => (
    <div className="my-1 flex gap-1 px-1">
      <input
        ref={createInputRef}
        type="text"
        value={newFolderName}
        disabled={creatingBusy}
        onChange={(e) => setNewFolderName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submitCreateFolder();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setCreatingParentId(null);
            setNewFolderName("");
          }
        }}
        placeholder={placeholder}
        className="min-w-0 flex-1 rounded border border-blue-400 bg-white px-2 py-1 text-[11px] focus:border-blue-500 focus:outline-none"
      />
      <button
        type="button"
        disabled={creatingBusy || !newFolderName.trim()}
        onClick={() => void submitCreateFolder()}
        className="rounded bg-blue-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        加
      </button>
      <button
        type="button"
        disabled={creatingBusy}
        onClick={() => {
          setCreatingParentId(null);
          setNewFolderName("");
        }}
        className="rounded border border-gray-200 bg-white px-1 text-gray-400 hover:text-gray-600"
        title="取消"
        aria-label="取消新建文件夹"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );

  const renderNode = (node: FolderTreeNode) => {
    const { folder, children } = node;
    const hasChildren = children.length > 0;
    const isExpanded = expandedIds.has(folder.id);
    const active = selectedFolderId === folder.id;
    const isCreatingChildHere = creatingParentId === folder.id;
    const isDraggingThis = draggingFolderId === folder.id;
    const isDropTarget = dragOverTargetId === folder.id && canDropOnFolder(folder.id);

    const countTooltip =
      node.descendantFolderCount > 0
        ? `当前目录 ${node.directAssetCount} 个素材，含子目录共 ${node.totalAssetCount} 个`
        : `${node.directAssetCount} 个素材`;

    return (
      <div key={folder.id} data-testid={`folder-node-${folder.id}`}>
        <div
          draggable
          onDragStart={(e) => handleDragStart(e, folder.id)}
          onDragEnd={handleDragEnd}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(FOLDER_DRAG_MIME)) return;
            if (!canDropOnFolder(folder.id)) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "move";
            if (dragOverTargetId !== folder.id) setDragOverTargetId(folder.id);
          }}
          onDragLeave={(e) => {
            if (
              dragOverTargetId === folder.id &&
              !(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))
            ) {
              setDragOverTargetId(null);
            }
          }}
          onDrop={(e) => void handleDropOnFolder(e, folder.id)}
          className={`group flex items-center gap-0.5 rounded-lg px-1.5 py-1 transition-colors ${
            isDropTarget
              ? "bg-blue-100/80 ring-1 ring-blue-500"
              : active
                ? "bg-blue-50 font-medium text-blue-700"
                : "text-gray-700 hover:bg-gray-100"
          } ${isDraggingThis ? "opacity-45" : ""}`}
        >
          {hasChildren ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                toggleExpand(folder.id);
              }}
              aria-label={isExpanded ? `收起 ${folder.name}` : `展开 ${folder.name}`}
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-gray-400 hover:bg-gray-200/70 hover:text-gray-700"
            >
              {isExpanded ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
            </button>
          ) : (
            <span className="h-4 w-4 shrink-0" aria-hidden="true" />
          )}

          <button
            type="button"
            onClick={() => onSelectFolder(active ? "" : folder.id)}
            title={node.pathLabel}
            className="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 text-left"
          >
            {active || (hasChildren && isExpanded) ? (
              <FolderOpen className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <Folder className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="truncate">{folder.name}</span>
          </button>

          <span
            title={countTooltip}
            className="font-mono-tabular shrink-0 pr-0.5 text-[10px] text-gray-400 group-hover:hidden group-focus-within:hidden"
          >
            {node.totalAssetCount}
          </span>

          <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex group-focus-within:flex">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                startCreateFolder(folder.id);
              }}
              className="rounded p-0.5 text-gray-400 hover:bg-gray-200/80 hover:text-blue-600"
              title="新建子文件夹"
              aria-label={`在 ${folder.name} 下新建子文件夹`}
            >
              <FolderPlus className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                openEditModal(node);
              }}
              className="rounded p-0.5 text-gray-400 hover:bg-gray-200/80 hover:text-gray-700"
              title="重命名或移动目录"
              aria-label={`编辑文件夹 ${folder.name}`}
            >
              <Pencil className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDeleteFolder(node);
              }}
              className="rounded p-0.5 text-gray-400 hover:bg-rose-50 hover:text-rose-600"
              title="删除文件夹"
              aria-label={`删除文件夹 ${folder.name}`}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        </div>

        {(isCreatingChildHere || (hasChildren && isExpanded)) && (
          <div
            className={
              node.depth < 6
                ? "mt-0.5 ml-3 space-y-0.5 border-l border-gray-200/80 pl-1.5"
                : "mt-0.5 space-y-0.5 pl-1"
            }
          >
            {isCreatingChildHere && renderInlineCreateInput(`在「${folder.name}」下新建子目录`)}
            {hasChildren && isExpanded && children.map((child) => renderNode(child))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between px-2">
        <span className="text-[11px] font-semibold text-gray-400">文件夹</span>
        <div className="flex items-center gap-0.5">
          {expandableIds.length > 0 && (
            <button
              type="button"
              onClick={toggleExpandAll}
              className="rounded p-0.5 text-gray-400 hover:bg-gray-200 hover:text-gray-700"
              title={allExpanded ? "全部收起" : "全部展开"}
              aria-label={allExpanded ? "全部收起文件夹" : "全部展开文件夹"}
            >
              {allExpanded ? (
                <ChevronsDownUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronsUpDown className="h-3.5 w-3.5" />
              )}
            </button>
          )}
          <button
            type="button"
            onClick={() => startCreateFolder(null)}
            className="rounded p-0.5 text-gray-400 hover:bg-gray-200 hover:text-gray-700"
            title="新建根目录"
            aria-label="新建根目录"
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {creatingParentId === ROOT_CREATE_SENTINEL && renderInlineCreateInput("根文件夹名称")}

      {draggingNode && draggingNode.folder.parentId !== null && (
        <div
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(FOLDER_DRAG_MIME)) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "move";
            if (dragOverTargetId !== ROOT_CREATE_SENTINEL) {
              setDragOverTargetId(ROOT_CREATE_SENTINEL);
            }
          }}
          onDragLeave={() => {
            if (dragOverTargetId === ROOT_CREATE_SENTINEL) setDragOverTargetId(null);
          }}
          onDrop={(e) => void handleDropOnFolder(e, null)}
          className={`mb-1.5 rounded-lg border border-dashed px-2 py-1 text-center text-[11px] transition-colors ${
            dragOverTargetId === ROOT_CREATE_SENTINEL
              ? "border-blue-500 bg-blue-50 font-medium text-blue-700"
              : "border-gray-300 bg-white/80 text-gray-500"
          }`}
        >
          拖到此处移至根目录
        </div>
      )}

      <div className="space-y-0.5" data-testid="folder-tree">
        {tree.roots.length === 0 ? (
          <p className="px-2 text-[11px] text-gray-400">暂无文件夹</p>
        ) : (
          tree.roots.map((root) => renderNode(root))
        )}
      </div>

      {/* Edit / Move Folder Modal */}
      {editingNode && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-[1px]"
          onClick={() => {
            if (!editBusy) setEditingNode(null);
          }}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-gray-100 pb-3">
              <h3 className="text-sm font-semibold text-gray-900">编辑文件夹</h3>
              <button
                type="button"
                disabled={editBusy}
                onClick={() => setEditingNode(null)}
                className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                aria-label="关闭弹窗"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 space-y-3 text-xs">
              <div>
                <label className="mb-1 block font-medium text-gray-700">文件夹名称</label>
                <input
                  type="text"
                  autoFocus
                  disabled={editBusy}
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void submitEditFolder();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setEditingNode(null);
                    }
                  }}
                  placeholder="输入文件夹名称"
                  className="w-full rounded-lg border border-gray-200 px-2.5 py-2 focus:border-blue-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="mb-1 block font-medium text-gray-700">上级目录</label>
                <select
                  disabled={editBusy}
                  value={editParentId}
                  onChange={(e) => setEditParentId(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-2 focus:border-blue-500 focus:outline-none"
                >
                  <option value="">根目录（顶级）</option>
                  {tree.flatNodes
                    .filter((candidate) => !blockedParentIdsForEdit.has(candidate.folder.id))
                    .map((candidate) => (
                      <option
                        key={candidate.folder.id}
                        value={candidate.folder.id}
                        title={candidate.pathLabel}
                      >
                        {formatFolderSelectOption(candidate)}
                      </option>
                    ))}
                </select>
                <p className="mt-1 text-[11px] text-gray-400">
                  支持拖拽左侧文件夹调整层级，也可以在这里直接选择上级目录。
                </p>
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2 border-t border-gray-100 pt-3 text-xs">
              <button
                type="button"
                disabled={editBusy}
                onClick={() => setEditingNode(null)}
                className="rounded-lg border border-gray-200 px-3.5 py-2 font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                disabled={editBusy || !editName.trim()}
                onClick={() => void submitEditFolder()}
                className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {editBusy ? "保存中..." : "保存"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
