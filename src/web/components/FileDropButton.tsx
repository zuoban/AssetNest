import { useRef, useState, type DragEvent, type ReactNode } from "react";

export function useFileDrop(onFiles: (files: File[]) => void, disabled = false) {
  const dragDepth = useRef(0);
  const [draggingOver, setDraggingOver] = useState(false);

  return {
    draggingOver: draggingOver && !disabled,
    dropProps: {
      onDragEnter(event: DragEvent<HTMLElement>) {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        dragDepth.current += 1;
        setDraggingOver(true);
      },
      onDragOver(event: DragEvent<HTMLElement>) {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = disabled ? "none" : "copy";
      },
      onDragLeave(event: DragEvent<HTMLElement>) {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && !event.currentTarget.contains(nextTarget)) {
          dragDepth.current = 0;
        } else {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
        }
        if (dragDepth.current === 0) setDraggingOver(false);
      },
      onDrop(event: DragEvent<HTMLElement>) {
        dragDepth.current = 0;
        setDraggingOver(false);
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        const files = Array.from(event.dataTransfer.files);
        if (!disabled && files.length > 0) onFiles(files);
      }
    }
  };
}

interface FileDropButtonProps {
  children: ReactNode;
  className: string;
  onFiles: (files: File[]) => void;
  multiple?: boolean;
  disabled?: boolean;
}

export function FileDropButton({
  children,
  className,
  onFiles,
  multiple = false,
  disabled = false
}: FileDropButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { draggingOver, dropProps } = useFileDrop(onFiles, disabled);

  return (
    <div {...dropProps}>
      <input
        ref={inputRef}
        type="file"
        multiple={multiple}
        disabled={disabled}
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (!disabled && files.length > 0) onFiles(files);
        }}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        className={`w-full rounded-lg border border-dashed text-gray-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:pointer-events-none disabled:opacity-50 ${
          draggingOver ? "border-blue-500 bg-blue-50" : "border-gray-300 bg-gray-50 hover:border-blue-400 hover:bg-blue-50/40"
        } ${className}`}
      >
        {children}
      </button>
    </div>
  );
}
