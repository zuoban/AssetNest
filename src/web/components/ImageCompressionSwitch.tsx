import { useId } from "react";

interface ImageCompressionSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function ImageCompressionSwitch({ checked, onChange, disabled }: ImageCompressionSwitchProps) {
  const id = useId();
  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-gray-700 has-disabled:opacity-50">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-description`}
        onChange={(event) => onChange(event.target.checked)}
        className="accent-blue-600"
      />
      <span id={`${id}-label`}>上传前压缩图片</span>
      <span id={`${id}-description`} className="text-gray-500">
        保持原分辨率，颜色可能略有变化。关闭后上传原文件。
      </span>
    </label>
  );
}
